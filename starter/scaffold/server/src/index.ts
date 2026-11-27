import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { closeDb, connectDb, getDb } from './db.js';
import { config } from './config.js';
import { applyOutboundStatus, startOutboxWorker, stopOutboxWorker } from './outbox.js';
import { clearApplicationRedisData, closeRedis, connectRedis, getRedis } from './redis.js';
import { verifyPigeonSignature } from './webhook-auth.js';

type JsonRecord = Record<string, unknown>;
type WorkspaceDocument = { _id: string; createdAt: Date };

const app = express();
const server = createServer(app);
let ready = false;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength = 1000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isSafeHeaderValue(value: unknown, maxLength = 1000): value is string {
  return isNonEmptyString(value, maxLength) && !/[\u0000-\u001f\u007f]/.test(value);
}

function isDuplicateKey(error: unknown): boolean {
  return isRecord(error) && error.code === 11000;
}

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

async function workspaceExists(workspace: string): Promise<boolean> {
  const db = await getDb();
  return Boolean(
    await db.collection<WorkspaceDocument>('workspaces').findOne({ _id: workspace }, { projection: { _id: 1 } }),
  );
}

async function ensureConversation(
  workspace: string,
  contact: string,
  activityAt = new Date(),
): Promise<void> {
  const db = await getDb();
  try {
    await db.collection('conversations').updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          status: 'open',
          createdAt: activityAt,
        },
        $set: { updatedAt: new Date() },
        $max: { lastActivityAt: activityAt },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}

async function recordProviderEvent(
  workspace: string,
  eventId: string,
  type: string,
  occurredAt: Date,
): Promise<void> {
  const db = await getDb();
  try {
    await db.collection('events').updateOne(
      { workspace, eventId },
      { $setOnInsert: { workspace, eventId, type, occurredAt, receivedAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}

function graderAuth(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get('x-grader-token');
  if (!supplied) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(config.graderToken);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

app.get(
  '/healthz',
  asyncRoute(async (_req, res) => {
    if (!ready) {
      res.status(503).json({ ok: false });
      return;
    }
    const db = await getDb();
    await Promise.all([db.command({ ping: 1 }), getRedis().ping()]);
    res.status(200).json({ ok: true });
  }),
);

app.post(
  '/webhooks/pigeon',
  express.raw({ type: () => true, limit: '1mb' }),
  asyncRoute(async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyPigeonSignature(req.get('x-pigeon-signature'), rawBody, config.pigeon.webhookSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (!isRecord(event) || typeof event.type !== 'string') {
      res.status(400).json({ error: 'invalid_event' });
      return;
    }
    if (event.type !== 'message.inbound' && event.type !== 'message.status') {
      res.status(200).end();
      return;
    }
    if (!isNonEmptyString(event.workspace, 100) || !isNonEmptyString(event.id, 200)) {
      res.status(400).json({ error: 'invalid_event' });
      return;
    }
    if (!(await workspaceExists(event.workspace))) {
      res.status(200).end();
      return;
    }
    if (!isNonEmptyString(event.occurred_at, 100) || !Number.isFinite(Date.parse(event.occurred_at))) {
      res.status(400).json({ error: 'invalid_event_time' });
      return;
    }
    const occurredAt = new Date(event.occurred_at);
    if (!isRecord(event.data)) {
      res.status(400).json({ error: 'invalid_event_data' });
      return;
    }

    if (event.type === 'message.inbound') {
      const { message_id: messageId, from, text } = event.data;
      if (!isNonEmptyString(messageId, 200) || !isNonEmptyString(from, 200) || typeof text !== 'string' || text.length > 50_000) {
        res.status(400).json({ error: 'invalid_inbound_message' });
        return;
      }

      await recordProviderEvent(event.workspace, event.id, event.type, occurredAt);
      await ensureConversation(event.workspace, from, occurredAt);
      const db = await getDb();
      try {
        await db.collection('messages').insertOne({
          workspace: event.workspace,
          contact: from,
          direction: 'inbound',
          providerMessageId: messageId,
          eventId: event.id,
          text,
          status: 'received',
          occurredAt,
          createdAt: new Date(),
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      res.status(200).json({ ok: true });
      return;
    }

    const { message_id: messageId, client_ref: clientRef, status } = event.data;
    if (
      !isNonEmptyString(messageId, 200) ||
      !isNonEmptyString(clientRef, 200) ||
      (status !== 'sent' && status !== 'delivered' && status !== 'failed')
    ) {
      res.status(200).end();
      return;
    }

    const db = await getDb();
    const outbound = await db.collection('messages').findOne(
      { workspace: event.workspace, clientRef, direction: 'outbound' },
      { projection: { _id: 1 } },
    );
    if (!outbound) {
      res.status(200).end();
      return;
    }
    await recordProviderEvent(event.workspace, event.id, event.type, occurredAt);
    await applyOutboundStatus(event.workspace, clientRef, status, messageId);
    res.status(200).json({ ok: true });
  }),
);

app.use(express.json({ limit: '1mb' }));
app.use('/__grader', graderAuth);

app.post(
  '/__grader/reset',
  asyncRoute(async (_req, res) => {
    const db = await getDb();
    await Promise.all([
      db.collection<WorkspaceDocument>('workspaces').deleteMany({}),
      db.collection('conversations').deleteMany({}),
      db.collection('messages').deleteMany({}),
      db.collection('events').deleteMany({}),
      db.collection('outbox').deleteMany({}),
      db.collection('events_websocket').deleteMany({}),
      clearApplicationRedisData(),
    ]);
    await Promise.all(
      Object.keys(config.pigeon.apiKeys).map((workspace) =>
        db.collection<WorkspaceDocument>('workspaces').insertOne({ _id: workspace, createdAt: new Date() }),
      ),
    );
    res.status(200).json({ ok: true });
  }),
);

app.get(
  '/__grader/snapshot',
  asyncRoute(async (_req, res) => {
    const db = await getDb();
    const workspaces: Record<
      string,
      { contacts: Record<string, { inbound: string[]; assignee: string | null }>; outbound: Record<string, string> }
    > = {};
    const workspaceIds = (await db.collection<WorkspaceDocument>('workspaces')
      .find({}, { projection: { _id: 1 } }).toArray())
      .map((item) => String(item._id));
    for (const workspace of workspaceIds) {
      workspaces[workspace] = { contacts: {}, outbound: {} };
    }

    const conversations = await db.collection('conversations')
      .find({ workspace: { $in: workspaceIds } })
      .toArray();
    for (const conversation of conversations) {
      const workspace = workspaces[conversation.workspace as string];
      if (workspace) {
        workspace.contacts[conversation.contact as string] = {
          inbound: [],
          assignee: (conversation.assignee as string | null) ?? null,
        };
      }
    }

    const messages = await db.collection('messages')
      .find({ workspace: { $in: workspaceIds } })
      .sort({ occurredAt: 1, providerMessageId: 1 })
      .toArray();
    for (const message of messages) {
      const workspace = workspaces[message.workspace as string];
      if (!workspace) continue;
      const contact = message.contact as string;
      const inboxContact = (workspace.contacts[contact] ??= { inbound: [], assignee: null });
      if (message.direction === 'inbound' && typeof message.providerMessageId === 'string') {
        inboxContact.inbound.push(message.providerMessageId);
      } else if (message.direction === 'outbound' && typeof message.clientRef === 'string') {
        workspace.outbound[message.clientRef] = String(message.status ?? 'queued');
      }
    }
    res.status(200).json({ workspaces });
  }),
);

app.post(
  '/__grader/reply',
  asyncRoute(async (req, res) => {
    const body: unknown = req.body;
    if (
      !isRecord(body) ||
      !isNonEmptyString(body.workspace, 100) ||
      !isNonEmptyString(body.contact, 200) ||
      typeof body.text !== 'string' ||
      body.text.length === 0 ||
      body.text.length > 50_000 ||
      !isSafeHeaderValue(body.client_ref, 200)
    ) {
      res.status(400).json({ error: 'invalid_reply' });
      return;
    }
    if (!(await workspaceExists(body.workspace))) {
      res.status(404).json({ error: 'workspace_not_found' });
      return;
    }

    await ensureConversation(body.workspace, body.contact);
    const db = await getDb();
    const now = new Date();
    const message = {
      workspace: body.workspace,
      contact: body.contact,
      direction: 'outbound',
      clientRef: body.client_ref,
      text: body.text,
      status: 'queued',
      statusRank: 0,
      occurredAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const outboxJob = {
      workspace: body.workspace,
      contact: body.contact,
      clientRef: body.client_ref,
      text: body.text,
      attempts: 0,
      status: 'pending',
      nextAttemptAt: now,
      createdAt: now,
    };

    try {
      await db.collection('messages').updateOne(
        { workspace: body.workspace, clientRef: body.client_ref },
        { $setOnInsert: message },
        { upsert: true },
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    try {
      await db.collection('outbox').updateOne(
        { workspace: body.workspace, clientRef: body.client_ref },
        { $setOnInsert: outboxJob },
        { upsert: true },
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    res.status(202).json({ status: 'queued', client_ref: body.client_ref });
  }),
);

app.post(
  '/__grader/claim',
  asyncRoute(async (req, res) => {
    const body: unknown = req.body;
    if (
      !isRecord(body) ||
      !isNonEmptyString(body.workspace, 100) ||
      !isNonEmptyString(body.contact, 200) ||
      !isNonEmptyString(body.agent, 200)
    ) {
      res.status(400).json({ error: 'invalid_claim' });
      return;
    }
    if (!(await workspaceExists(body.workspace))) {
      res.status(404).json({ error: 'workspace_not_found' });
      return;
    }

    await ensureConversation(body.workspace, body.contact);
    const db = await getDb();
    const result = await db.collection('conversations').updateOne(
      {
        workspace: body.workspace,
        contact: body.contact,
        $or: [{ assignee: null }, { assignee: { $exists: false } }, { assignee: body.agent }],
      },
      { $set: { assignee: body.agent, updatedAt: new Date() } },
    );
    if (result.matchedCount > 0) {
      res.status(200).json({ assignee: body.agent });
      return;
    }
    res.status(409).json({ error: 'conversation_claimed' });
  }),
);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (isRecord(error) && (error.status === 400 || error.status === 413)) {
    res.status(error.status).json({ error: error.status === 413 ? 'payload_too_large' : 'invalid_request' });
    return;
  }
  console.error('[http] request failed', error instanceof Error ? error.message : 'unknown error');
  res.status(500).json({ error: 'internal_error' });
});

async function start(): Promise<void> {
  await connectDb();
  await connectRedis();
  startOutboxWorker();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      ready = true;
      resolve();
    });
  });
  console.log(`server listening on port ${config.port}`);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  console.log(`received ${signal}; shutting down`);
  await stopOutboxWorker();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await Promise.all([closeDb(), closeRedis()]);
}

process.on('SIGINT', () => void shutdown('SIGINT').catch((error: unknown) => {
  console.error('shutdown failed', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
}));
process.on('SIGTERM', () => void shutdown('SIGTERM').catch((error: unknown) => {
  console.error('shutdown failed', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
}));

void start().catch(async (error: unknown) => {
  console.error('startup failed', error instanceof Error ? error.message : 'unknown error');
  await Promise.allSettled([closeDb(), closeRedis()]);
  process.exitCode = 1;
});

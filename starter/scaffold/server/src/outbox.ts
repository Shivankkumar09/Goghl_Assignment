import { randomUUID } from 'node:crypto';
import type { Db, ObjectId } from 'mongodb';
import { config } from './config.js';
import { getDb, getMongoClient, mongoSupportsTransactions } from './db.js';
import { getRedis } from './redis.js';

type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed';
type JobStatus = 'pending' | 'processing' | 'accepted' | 'failed';

type OutboundMessage = {
  workspace: string;
  contact: string;
  direction: 'outbound';
  clientRef: string;
  text: string;
  status: DeliveryStatus;
  statusRank: number;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
  providerMessageId?: string;
};

type PendingStatusEvent = {
  eventKey: string;
  type: 'message.status';
  contact: string;
  client_ref: string;
  status: Exclude<DeliveryStatus, 'queued'>;
  createdAt: Date;
};

type OutboxJob = {
  _id: ObjectId;
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
  message?: OutboundMessage;
  attempts: number;
  status: JobStatus;
  deliveryStatus?: DeliveryStatus;
  statusRank?: number;
  nextAttemptAt: Date;
  createdAt: Date;
  leaseUntil?: Date;
  claimToken?: string;
  providerMessageId?: string;
  pendingStatusEvents?: PendingStatusEvent[];
};

type WorkspaceState = {
  _id: string;
  sendNextAt?: Date;
  lastEventSeq?: number;
};

type PersistedStatusEvent = {
  _id?: ObjectId;
  workspace: string;
  seq: number;
  eventKey: string;
  type: 'message.status';
  contact: string;
  client_ref: string;
  status: Exclude<DeliveryStatus, 'queued'>;
  createdAt: Date;
  publishedAt?: Date;
};

type NewOutboundMessage = {
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
};

const leaseMs = 20_000;
const workspaceSendIntervalMs = 250;
let stopped = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let active: Promise<void> | undefined;

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function rankFor(status: Exclude<DeliveryStatus, 'queued'>): number {
  return status === 'sent' ? 1 : 2;
}

export function retryDelay(attempt: number, retryAfter?: string | null, nowMs = Date.now()): number {
  if (retryAfter !== undefined && retryAfter !== null) {
    const value = retryAfter.trim();
    const seconds = Number(value);
    if (value !== '' && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  return Math.min(30_000, 500 * 2 ** Math.max(0, Math.min(attempt - 1, 6)));
}

function messageFromJob(job: OutboxJob): OutboundMessage {
  const stored = job.message;
  const message =
    stored &&
    stored.workspace === job.workspace &&
    stored.contact === job.contact &&
    stored.clientRef === job.clientRef &&
    typeof stored.text === 'string'
      ? stored
      : {
          workspace: job.workspace,
          contact: job.contact,
          direction: 'outbound' as const,
          clientRef: job.clientRef,
          text: job.text,
          status: 'queued' as const,
          statusRank: 0,
          occurredAt: job.createdAt,
          createdAt: job.createdAt,
          updatedAt: job.createdAt,
        };
  return {
    ...message,
    status: job.deliveryStatus ?? message.status,
    statusRank: job.statusRank ?? message.statusRank,
    ...(job.providerMessageId ? { providerMessageId: job.providerMessageId } : {}),
  };
}

async function ensureMessageMirror(db: Db, job: OutboxJob): Promise<void> {
  const message = messageFromJob(job);
  const messages = db.collection<OutboundMessage>('messages');
  await messages.updateOne(
    { workspace: job.workspace, clientRef: job.clientRef },
    { $setOnInsert: message },
    { upsert: true },
  );
  const statusRank = job.statusRank ?? 0;
  if (statusRank > 0) {
    await messages.updateOne(
      {
        workspace: job.workspace,
        clientRef: job.clientRef,
        $or: [{ statusRank: { $lt: statusRank } }, { statusRank: { $exists: false } }],
      },
      {
        $set: {
          status: job.deliveryStatus ?? 'queued',
          statusRank,
          updatedAt: new Date(),
          ...(job.providerMessageId ? { providerMessageId: job.providerMessageId } : {}),
        },
      },
    );
  }
  if (job.providerMessageId) {
    await messages.updateOne(
      { workspace: job.workspace, clientRef: job.clientRef },
      { $set: { providerMessageId: job.providerMessageId } },
    );
  }
}

export async function persistOutboundMessage(input: NewOutboundMessage): Promise<{ contact: string }> {
  const db = await getDb();
  const now = new Date();
  const message: OutboundMessage = {
    ...input,
    direction: 'outbound',
    status: 'queued',
    statusRank: 0,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const job = {
    ...input,
    message,
    attempts: 0,
    status: 'pending' as const,
    deliveryStatus: 'queued' as const,
    statusRank: 0,
    nextAttemptAt: now,
    createdAt: now,
    pendingStatusEvents: [] as PendingStatusEvent[],
  };
  const filter = { workspace: input.workspace, clientRef: input.clientRef };
  const outbox = db.collection<OutboxJob>('outbox');

  if (mongoSupportsTransactions()) {
    const session = getMongoClient().startSession();
    try {
      await session.withTransaction(async () => {
        await outbox.updateOne(filter, { $setOnInsert: job }, { upsert: true, session });
        const persistedJob = await outbox.findOne(filter, { session });
        if (!persistedJob) throw new Error('Outbox job missing after upsert');
        await db.collection<OutboundMessage>('messages').updateOne(
          filter,
          { $setOnInsert: messageFromJob(persistedJob) },
          { upsert: true, session },
        );
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    } finally {
      await session.endSession();
    }
  } else {
    try {
      await outbox.updateOne(filter, { $setOnInsert: job }, { upsert: true });
    } catch (error) {
      if (!isDuplicateKey(error) || !(await outbox.findOne(filter))) throw error;
    }
  }
  const persisted = await outbox.findOne(filter, { projection: { contact: 1 } });
  if (!persisted) throw new Error('Outbox job missing after persistence');
  return { contact: persisted.contact };
}

async function reserveWorkspaceSendSlot(
  db: Db,
  workspace: string,
): Promise<{ reserved: true } | { reserved: false; retryAt: Date } | { reserved: false; missing: true }> {
  const now = new Date();
  const reserved = await db.collection<WorkspaceState>('workspaces').findOneAndUpdate(
    {
      _id: workspace,
      $or: [{ sendNextAt: { $exists: false } }, { sendNextAt: { $lte: now } }],
    },
    { $set: { sendNextAt: new Date(now.getTime() + workspaceSendIntervalMs) } },
    { returnDocument: 'after' },
  );
  if (reserved) return { reserved: true };

  const current = await db.collection<WorkspaceState>('workspaces').findOne(
    { _id: workspace },
    { projection: { sendNextAt: 1 } },
  );
  if (!current) return { reserved: false, missing: true };
  return {
    reserved: false,
    retryAt: current.sendNextAt ?? new Date(Date.now() + workspaceSendIntervalMs),
  };
}

async function deferWorkspaceSends(db: Db, workspace: string, delayMs: number): Promise<void> {
  await db.collection<WorkspaceState>('workspaces').updateOne(
    { _id: workspace },
    { $max: { sendNextAt: new Date(Date.now() + delayMs) } },
  );
}

async function releaseJob(
  db: Db,
  job: OutboxJob,
  claimToken: string,
  error: string,
  delayMs: number,
): Promise<void> {
  await db.collection<OutboxJob>('outbox').updateOne(
    { _id: job._id, status: 'processing', claimToken },
    {
      $set: {
        status: 'pending',
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError: error,
      },
      $unset: { leaseUntil: '', claimToken: '' },
    },
  );
}

async function stageStatusEvent(
  db: Db,
  job: OutboxJob,
  status: Exclude<DeliveryStatus, 'queued'>,
  providerMessageId?: string,
  claimToken?: string,
): Promise<void> {
  const rank = rankFor(status);
  const now = new Date();
  const event: PendingStatusEvent = {
    eventKey: JSON.stringify([job.clientRef, status]),
    type: 'message.status',
    contact: job.contact,
    client_ref: job.clientRef,
    status,
    createdAt: now,
  };
  const filter: Record<string, unknown> = {
    workspace: job.workspace,
    clientRef: job.clientRef,
    $or: [{ statusRank: { $lt: rank } }, { statusRank: { $exists: false } }],
  };
  if (claimToken) filter.claimToken = claimToken;

  const updated = await db.collection<OutboxJob>('outbox').findOneAndUpdate(
    filter,
    {
      $set: {
        deliveryStatus: status,
        statusRank: rank,
        updatedAt: now,
        'message.status': status,
        'message.statusRank': rank,
        'message.updatedAt': now,
        ...(providerMessageId
          ? {
              providerMessageId,
              'message.providerMessageId': providerMessageId,
            }
          : {}),
      },
      $push: { pendingStatusEvents: event },
    },
    { returnDocument: 'after' },
  );

  if (updated) {
    await ensureMessageMirror(db, updated);
    return;
  }

  if (providerMessageId) {
    await db.collection<OutboxJob>('outbox').updateOne(
      { workspace: job.workspace, clientRef: job.clientRef, ...(claimToken ? { claimToken } : {}) },
      { $set: { providerMessageId, 'message.providerMessageId': providerMessageId } },
    );
  }
}

async function markJobFailed(
  db: Db,
  job: OutboxJob,
  claimToken: string,
  reason: string,
): Promise<void> {
  await stageStatusEvent(db, job, 'failed', undefined, claimToken);
  await db.collection<OutboxJob>('outbox').updateOne(
    { _id: job._id, status: 'processing', claimToken },
    {
      $set: { status: 'failed', lastError: reason },
      $unset: { leaseUntil: '', claimToken: '' },
    },
  );
}

async function publishPendingStatusEvents(db: Db): Promise<void> {
  const jobs = await db.collection<OutboxJob>('outbox')
    .find({ pendingStatusEvents: { $exists: true, $ne: [] } })
    .sort({ createdAt: 1 })
    .limit(50)
    .toArray();
  const eventCollection = db.collection<PersistedStatusEvent>('events_websocket');
  const redis = getRedis();

  for (const job of jobs) {
    for (const event of job.pendingStatusEvents ?? []) {
      let persisted = await eventCollection.findOne(
        { workspace: job.workspace, eventKey: event.eventKey },
      );
      if (!persisted) {
        const workspace = await db.collection<WorkspaceState>('workspaces').findOneAndUpdate(
          { _id: job.workspace },
          { $inc: { lastEventSeq: 1 } },
          { returnDocument: 'after' },
        );
        if (!workspace) throw new Error(`Workspace ${job.workspace} missing while assigning event sequence`);
        const seq = Number(workspace.lastEventSeq);
        if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid workspace event sequence');
        const eventDocument = {
          workspace: job.workspace,
          seq,
          eventKey: event.eventKey,
          type: event.type,
          contact: event.contact,
          client_ref: event.client_ref,
          status: event.status,
          createdAt: event.createdAt,
        };
        try {
          await eventCollection.insertOne(eventDocument);
          persisted = await eventCollection.findOne({ workspace: job.workspace, eventKey: event.eventKey });
          if (!persisted) throw new Error('Persistent status event is missing after insertion');
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          persisted = await eventCollection.findOne({ workspace: job.workspace, eventKey: event.eventKey });
          if (!persisted) throw error;
        }
      }

      if (!persisted) throw new Error('Persistent status event is missing');
      if (!persisted.publishedAt) {
        await redis.publish(
          `switchboard:events:${job.workspace}`,
          JSON.stringify({
            seq: persisted.seq,
            type: persisted.type,
            contact: persisted.contact,
            client_ref: persisted.client_ref,
            status: persisted.status,
          }),
        );
        await eventCollection.updateOne(
          { _id: persisted._id },
          { $set: { publishedAt: new Date() } },
        );
      }
      await db.collection<OutboxJob>('outbox').updateOne(
        { _id: job._id, 'pendingStatusEvents.eventKey': event.eventKey },
        { $pull: { pendingStatusEvents: { eventKey: event.eventKey } } },
      );
    }
  }
}

async function claimJob(db: Db): Promise<{ job: OutboxJob; claimToken: string } | null> {
  const now = new Date();
  const claimToken = randomUUID();
  const job = await db.collection<OutboxJob>('outbox').findOneAndUpdate(
    {
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'processing', leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'processing',
        leaseUntil: new Date(now.getTime() + leaseMs),
        claimToken,
      },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' },
  );
  return job ? { job, claimToken } : null;
}

async function processOne(db: Db): Promise<void> {
  const claimed = await claimJob(db);
  if (!claimed) return;
  const { job, claimToken } = claimed;
  await ensureMessageMirror(db, job);

  const slot = await reserveWorkspaceSendSlot(db, job.workspace);
  if (!slot.reserved) {
    if ('missing' in slot) {
      await markJobFailed(db, job, claimToken, 'Workspace no longer exists');
      return;
    }
    await releaseJob(
      db,
      job,
      claimToken,
      'Waiting for the workspace send slot',
      Math.max(1, slot.retryAt.getTime() - Date.now()),
    );
    return;
  }

  const apiKey = config.pigeon.apiKeys[job.workspace];
  if (!apiKey) {
    await markJobFailed(db, job, claimToken, 'Workspace provider key is not configured');
    return;
  }

  let response: Response;
  try {
    response = await fetch(new URL('/v1/messages', config.pigeon.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': job.clientRef,
      },
      body: JSON.stringify({ to: job.contact, text: job.text, client_ref: job.clientRef }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    await releaseJob(db, job, claimToken, 'Provider request failed or timed out', retryDelay(job.attempts));
    return;
  }

  if (response.status === 429 || response.status >= 500) {
    const delay = retryDelay(job.attempts, response.headers.get('retry-after'));
    if (response.status === 429) await deferWorkspaceSends(db, job.workspace, delay);
    await releaseJob(db, job, claimToken, `Provider returned HTTP ${response.status}`, delay);
    return;
  }

  if (!response.ok) {
    await markJobFailed(db, job, claimToken, `Provider returned HTTP ${response.status}`);
    return;
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    await releaseJob(db, job, claimToken, 'Provider returned an invalid response body', retryDelay(job.attempts));
    return;
  }

  const providerMessageId =
    typeof result === 'object' &&
    result !== null &&
    'id' in result &&
    typeof result.id === 'string'
      ? result.id
      : undefined;
  if (!providerMessageId) {
    await releaseJob(db, job, claimToken, 'Provider response did not contain a message id', retryDelay(job.attempts));
    return;
  }

  await stageStatusEvent(db, job, 'sent', providerMessageId, claimToken);
  await db.collection<OutboxJob>('outbox').updateOne(
    { _id: job._id, status: 'processing', claimToken },
    {
      $set: { status: 'accepted', providerMessageId, acceptedAt: new Date() },
      $unset: { leaseUntil: '', claimToken: '' },
    },
  );
}

async function tick(): Promise<void> {
  if (stopped) return;
  active = (async () => {
    const db = await getDb();
    await publishPendingStatusEvents(db);
    await processOne(db);
  })();
  try {
    await active;
  } catch (error) {
    console.error('[outbox] worker iteration failed', error instanceof Error ? error.message : 'unknown error');
  } finally {
    active = undefined;
    if (!stopped) timer = setTimeout(() => void tick(), 100);
  }
}

export function startOutboxWorker(): void {
  if (!stopped) return;
  stopped = false;
  void tick();
}

export async function stopOutboxWorker(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
  await active;
}

export async function applyOutboundStatus(
  workspace: string,
  clientRef: string,
  status: 'sent' | 'delivered' | 'failed',
  providerMessageId: string,
): Promise<boolean> {
  const db = await getDb();
  const job = await db.collection<OutboxJob>('outbox').findOne({ workspace, clientRef });
  if (!job) return false;
  const previousRank = job.statusRank ?? 0;
  const updated = await db.collection<OutboxJob>('outbox').findOneAndUpdate(
    {
      workspace,
      clientRef,
      $or: [{ statusRank: { $lt: rankFor(status) } }, { statusRank: { $exists: false } }],
    },
    {
      $set: {
        deliveryStatus: status,
        statusRank: rankFor(status),
        providerMessageId,
        updatedAt: new Date(),
        'message.status': status,
        'message.statusRank': rankFor(status),
        'message.providerMessageId': providerMessageId,
        'message.updatedAt': new Date(),
      },
      $push: {
        pendingStatusEvents: {
          eventKey: JSON.stringify([clientRef, status]),
          type: 'message.status',
          contact: job.contact,
          client_ref: clientRef,
          status,
          createdAt: new Date(),
        },
      },
    },
    { returnDocument: 'after' },
  );
  if (updated) await ensureMessageMirror(db, updated);
  return Boolean(updated) || previousRank >= rankFor(status);
}

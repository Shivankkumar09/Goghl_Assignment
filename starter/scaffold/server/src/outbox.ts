import { randomUUID } from 'node:crypto';
import type { Db, ObjectId } from 'mongodb';
import { config } from './config.js';
import { getDb } from './db.js';

type OutboxJob = {
  _id: ObjectId;
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
  attempts: number;
  status: 'pending' | 'processing' | 'accepted' | 'failed';
  nextAttemptAt: Date;
  createdAt: Date;
  lockedAt?: Date;
  workerId?: string;
};

const workerId = randomUUID();
const leaseMs = 30_000;
let stopped = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let active: Promise<void> | undefined;

function retryDelay(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6));
}

async function updateMessageStatus(
  db: Db,
  job: OutboxJob,
  status: 'sent' | 'delivered' | 'failed',
  statusRank: number,
  providerMessageId?: string,
): Promise<void> {
  const messages = db.collection('messages');
  await messages.updateOne(
    { workspace: job.workspace, clientRef: job.clientRef, statusRank: { $lt: statusRank } },
    {
      $set: {
        status,
        statusRank,
        updatedAt: new Date(),
        ...(providerMessageId ? { providerMessageId } : {}),
      },
    },
  );
  if (providerMessageId) {
    await messages.updateOne(
      { workspace: job.workspace, clientRef: job.clientRef },
      { $set: { providerMessageId } },
    );
  }
}

async function releaseJob(
  db: Db,
  job: OutboxJob,
  lastError: string,
  delayMs: number,
): Promise<void> {
  await db.collection<OutboxJob>('outbox').updateOne(
    { _id: job._id, workerId },
    {
      $set: {
        status: 'pending',
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError,
      },
      $unset: { lockedAt: '', workerId: '' },
    },
  );
}

async function processOne(): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const job = await db.collection<OutboxJob>('outbox').findOneAndUpdate(
    {
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'processing', lockedAt: { $lte: new Date(now.getTime() - leaseMs) } },
      ],
    },
    {
      $set: { status: 'processing', lockedAt: now, workerId },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!job) return;

  const apiKey = config.pigeon.apiKeys[job.workspace];
  if (!apiKey) {
    await db.collection<OutboxJob>('outbox').updateOne(
      { _id: job._id, workerId },
      { $set: { status: 'failed', lastError: 'Workspace provider key is not configured' }, $unset: { lockedAt: '', workerId: '' } },
    );
    await updateMessageStatus(db, job, 'failed', 2);
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
    await releaseJob(db, job, 'Provider request failed or timed out', retryDelay(job.attempts));
    return;
  }

  if (response.status === 429 || response.status >= 500) {
    await releaseJob(
      db,
      job,
      `Provider returned HTTP ${response.status}`,
      retryDelay(job.attempts, response.headers.get('retry-after')),
    );
    return;
  }

  if (!response.ok) {
    await db.collection<OutboxJob>('outbox').updateOne(
      { _id: job._id, workerId },
      {
        $set: { status: 'failed', lastError: `Provider returned HTTP ${response.status}` },
        $unset: { lockedAt: '', workerId: '' },
      },
    );
    await updateMessageStatus(db, job, 'failed', 2);
    return;
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    await releaseJob(db, job, 'Provider returned an invalid response body', retryDelay(job.attempts));
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
    await releaseJob(db, job, 'Provider response did not contain a message id', retryDelay(job.attempts));
    return;
  }

  await db.collection<OutboxJob>('outbox').updateOne(
    { _id: job._id, workerId },
    {
      $set: { status: 'accepted', providerMessageId, acceptedAt: new Date() },
      $unset: { lockedAt: '', workerId: '' },
    },
  );
  await updateMessageStatus(db, job, 'sent', 1, providerMessageId);
}

async function tick(): Promise<void> {
  if (stopped) return;
  active = processOne();
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
  const rank = status === 'sent' ? 1 : 2;
  const result = await db.collection('messages').updateOne(
    { workspace, clientRef, direction: 'outbound', statusRank: { $lt: rank } },
    { $set: { status, statusRank: rank, providerMessageId, updatedAt: new Date() } },
  );
  return result.matchedCount > 0;
}

import { randomUUID } from 'node:crypto';
import type { Db, ObjectId, ClientSession } from 'mongodb';
import { getDb, getMongoClient, mongoSupportsTransactions } from './db.js';
import { getRedis } from './redis.js';

export type WorkspaceEventInput = {
  workspace: string;
  eventKey: string;
  type: 'message.inbound' | 'message.status' | 'conversation.assigned' | 'conversation.status';
  contact: string;
  message_id?: string;
  client_ref?: string;
  status?: 'sent' | 'delivered' | 'failed';
  assignee?: string;
  conversation_status?: 'open' | 'closed';
};

export type WorkspaceEventDocument = WorkspaceEventInput & {
  _id?: ObjectId;
  seq: number;
  createdAt: Date;
  publishedAt?: Date;
};

type WorkspaceSequence = {
  _id: string;
  lastEventSeq?: number;
  eventLockToken?: string;
  eventLockUntil?: Date;
};

const eventLockMs = 30_000;

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function createEventDocument(input: WorkspaceEventInput, seq: number): WorkspaceEventDocument {
  return { ...input, seq, createdAt: new Date() };
}

async function allocateSequence(
  db: Db,
  input: WorkspaceEventInput,
  session?: ClientSession,
  lockToken?: string,
): Promise<WorkspaceEventDocument> {
  const workspace = await db.collection<WorkspaceSequence>('workspaces').findOneAndUpdate(
    {
      _id: input.workspace,
      ...(lockToken
        ? { eventLockToken: lockToken, eventLockUntil: { $gt: new Date() } }
        : {}),
    },
    { $inc: { lastEventSeq: 1 } },
    { returnDocument: 'after', ...(session ? { session } : {}) },
  );
  const seq = Number(workspace?.lastEventSeq);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error(`Could not allocate event sequence for workspace ${input.workspace}`);
  }
  return createEventDocument(input, seq);
}

async function appendWithTransaction(
  db: Db,
  input: WorkspaceEventInput,
): Promise<WorkspaceEventDocument> {
  const events = db.collection<WorkspaceEventDocument>('events_websocket');
  const session = getMongoClient().startSession();
  let result: WorkspaceEventDocument | null = null;
  try {
    await session.withTransaction(async () => {
      result = await events.findOne(
        { workspace: input.workspace, eventKey: input.eventKey },
        { session },
      );
      if (result) return;
      const event = await allocateSequence(db, input, session);
      await events.insertOne(event, { session });
      result = await events.findOne(
        { workspace: input.workspace, eventKey: input.eventKey },
        { session },
      );
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    result = await events.findOne({ workspace: input.workspace, eventKey: input.eventKey });
  } finally {
    await session.endSession();
  }
  if (!result) throw new Error('Workspace event was not persisted');
  return result;
}

async function appendWithStandaloneLock(
  db: Db,
  input: WorkspaceEventInput,
): Promise<WorkspaceEventDocument> {
  const events = db.collection<WorkspaceEventDocument>('events_websocket');
  const workspaces = db.collection<WorkspaceSequence>('workspaces');
  const lockToken = randomUUID();
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const now = new Date();
    const lock = await workspaces.findOneAndUpdate(
      {
        _id: input.workspace,
        $or: [
          { eventLockUntil: { $exists: false } },
          { eventLockUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          eventLockToken: lockToken,
          eventLockUntil: new Date(now.getTime() + eventLockMs),
        },
      },
      { returnDocument: 'after' },
    );

    if (lock) {
      try {
        const existing = await events.findOne({
          workspace: input.workspace,
          eventKey: input.eventKey,
        });
        if (existing) return existing;

        const event = await allocateSequence(db, input, undefined, lockToken);
        const ownedLock = await workspaces.findOne(
          {
            _id: input.workspace,
            eventLockToken: lockToken,
            eventLockUntil: { $gt: new Date() },
          },
          { projection: { _id: 1 } },
        );
        if (!ownedLock) throw new Error('Workspace event sequence lock expired');
        await events.insertOne(event);
        const persisted = await events.findOne({
          workspace: input.workspace,
          eventKey: input.eventKey,
        });
        if (!persisted) throw new Error('Workspace event was not persisted');
        return persisted;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const existing = await events.findOne({
          workspace: input.workspace,
          eventKey: input.eventKey,
        });
        if (!existing) throw error;
        return existing;
      } finally {
        await workspaces.updateOne(
          { _id: input.workspace, eventLockToken: lockToken },
          { $unset: { eventLockToken: '', eventLockUntil: '' } },
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out sequencing event for workspace ${input.workspace}`);
}

export async function appendWorkspaceEvent(
  db: Db,
  input: WorkspaceEventInput,
): Promise<WorkspaceEventDocument> {
  const events = db.collection<WorkspaceEventDocument>('events_websocket');
  const existing = await events.findOne({
    workspace: input.workspace,
    eventKey: input.eventKey,
  });
  if (existing) return existing;
  if (mongoSupportsTransactions()) return appendWithTransaction(db, input);
  return appendWithStandaloneLock(db, input);
}

export async function publishUnpublishedEvents(database?: Db): Promise<void> {
  const db = database ?? await getDb();
  const events = await db.collection<WorkspaceEventDocument>('events_websocket')
    .find({ publishedAt: { $exists: false } })
    .sort({ workspace: 1, seq: 1 })
    .limit(100)
    .toArray();
  const redis = getRedis();

  for (const event of events) {
    const {
      workspace,
      seq,
      type,
      contact,
      message_id,
      client_ref,
      status,
      assignee,
      conversation_status,
    } = event;
    const frame = {
      seq,
      type,
      contact,
      ...(message_id ? { message_id } : {}),
      ...(client_ref ? { client_ref } : {}),
      ...(status ? { status } : {}),
      ...(assignee ? { assignee } : {}),
      ...(conversation_status ? { status: conversation_status } : {}),
    };
    await redis.publish(`switchboard:events:${workspace}`, JSON.stringify(frame));
    await db.collection<WorkspaceEventDocument>('events_websocket').updateOne(
      { _id: event._id, publishedAt: { $exists: false } },
      { $set: { publishedAt: new Date() } },
    );
  }
}

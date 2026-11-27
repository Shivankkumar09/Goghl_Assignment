import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;
let connection: Promise<Db> | undefined;
let supportsTransactions = false;

export async function connectDb(): Promise<Db> {
  const mongo = client ?? new MongoClient(config.mongoUrl);
  client = mongo;
  if (!connection) {
    connection = (async () => {
      await mongo.connect();
      const db = mongo.db();
      const hello = await db.admin().command({ hello: 1 });
      supportsTransactions = typeof hello.setName === 'string' || hello.msg === 'isdbgrid';
      await Promise.all([
        db.collection('conversations').createIndex(
          { workspace: 1, contact: 1 },
          { unique: true, name: 'conversation_workspace_contact' },
        ),
        db.collection('conversations').createIndex(
          { workspace: 1, lastActivityAt: -1 },
          { name: 'workspace_activity' },
        ),
        db.collection('messages').createIndex(
          { workspace: 1, providerMessageId: 1 },
          {
            unique: true,
            name: 'workspace_provider_message',
            partialFilterExpression: { providerMessageId: { $type: 'string' } },
          },
        ),
        db.collection('messages').createIndex(
          { workspace: 1, clientRef: 1 },
          {
            unique: true,
            name: 'message_workspace_client_ref',
            partialFilterExpression: { clientRef: { $type: 'string' } },
          },
        ),
        db.collection('messages').createIndex(
          { workspace: 1, contact: 1, occurredAt: 1, providerMessageId: 1 },
          { name: 'workspace_contact_message_order' },
        ),
        db.collection('events').createIndex(
          { workspace: 1, eventId: 1 },
          { unique: true, name: 'workspace_event_id' },
        ),
        db.collection('outbox').createIndex(
          { workspace: 1, clientRef: 1 },
          { unique: true, name: 'outbox_workspace_client_ref' },
        ),
        db.collection('outbox').createIndex(
          { status: 1, nextAttemptAt: 1, leaseUntil: 1, createdAt: 1 },
          { name: 'outbox_claim_jobs' },
        ),
        db.collection('events_websocket').createIndex(
          { workspace: 1, seq: 1 },
          { unique: true, name: 'ws_workspace_seq' },
        ),
        db.collection('events_websocket').createIndex(
          { workspace: 1, eventKey: 1 },
          {
            unique: true,
            name: 'workspace_event_key',
            partialFilterExpression: { eventKey: { $type: 'string' } },
          },
        ),
      ]);
      await Promise.all(
        Object.keys(config.pigeon.apiKeys).map((workspace) =>
          db.collection<{ _id: string; createdAt: Date }>('workspaces').updateOne(
            { _id: workspace },
            { $setOnInsert: { createdAt: new Date() } },
            { upsert: true },
          ),
        ),
      );
      await Promise.all(
        Object.keys(config.pigeon.apiKeys).map(async (workspace) => {
          const latest = await db.collection('events_websocket')
            .find({ workspace })
            .sort({ seq: -1 })
            .limit(1)
            .next();
          await db.collection<{ _id: string }>('workspaces').updateOne(
            { _id: workspace },
            { $max: { lastEventSeq: Number(latest?.seq ?? 0) } },
          );
        }),
      );
      await db.collection('outbox').updateMany(
        { status: 'processing', leaseUntil: { $exists: false } },
        { $set: { leaseUntil: new Date(0) } },
      );
      await db.collection('outbox').updateMany(
        { status: 'pending', nextAttemptAt: { $exists: false } },
        { $set: { nextAttemptAt: new Date(0) } },
      );
      return db;
    })();
  }
  return connection;
}

export function getDb(): Promise<Db> {
  return connection ?? connectDb();
}

export function getMongoClient(): MongoClient {
  if (!client) throw new Error('MongoDB is not connected');
  return client;
}

export function mongoSupportsTransactions(): boolean {
  return supportsTransactions;
}

export async function closeDb(): Promise<void> {
  if (client) await client.close();
  client = undefined;
  connection = undefined;
  supportsTransactions = false;
}

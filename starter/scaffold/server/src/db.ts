import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;
let connection: Promise<Db> | undefined;

export async function connectDb(): Promise<Db> {
  const mongo = client ?? new MongoClient(config.mongoUrl);
  client = mongo;
  if (!connection) {
    connection = (async () => {
      await mongo.connect();
      const db = mongo.db();
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
          { status: 1, nextAttemptAt: 1, createdAt: 1 },
          { name: 'outbox_due_jobs' },
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
      return db;
    })();
  }
  return connection;
}

export function getDb(): Promise<Db> {
  return connection ?? connectDb();
}

export async function closeDb(): Promise<void> {
  if (client) await client.close();
  client = undefined;
  connection = undefined;
}

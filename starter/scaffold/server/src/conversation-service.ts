import type { Db } from 'mongodb';
import { getDb } from './db.js';
import { appendWorkspaceEvent } from './events.js';

type ConversationDocument = {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  assignmentVersion?: number;
  statusVersion?: number;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt?: Date;
};

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

export async function workspaceExists(workspace: string): Promise<boolean> {
  const db = await getDb();
  return Boolean(
    await db.collection<{ _id: string }>('workspaces').findOne(
      { _id: workspace },
      { projection: { _id: 1 } },
    ),
  );
}

export async function ensureConversation(
  workspace: string,
  contact: string,
  activityAt = new Date(),
): Promise<void> {
  const db = await getDb();
  try {
    await db.collection<ConversationDocument>('conversations').updateOne(
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

export async function claimConversation(
  workspace: string,
  contact: string,
  agent: string,
): Promise<boolean> {
  await ensureConversation(workspace, contact);
  const db = await getDb();
  const conversations = db.collection<ConversationDocument>('conversations');
  const assigned = await conversations.findOneAndUpdate(
    {
      workspace,
      contact,
      $or: [{ assignee: null }, { assignee: { $exists: false } }],
    },
    {
      $set: { assignee: agent, updatedAt: new Date() },
      $inc: { assignmentVersion: 1 },
    },
    { returnDocument: 'after' },
  );
  const current = assigned ?? await conversations.findOne({
    workspace,
    contact,
    assignee: agent,
  });
  if (!current) return false;

  const assignmentVersion = Number(current.assignmentVersion ?? 0);
  await appendWorkspaceEvent(db, {
    workspace,
    eventKey: JSON.stringify(['conversation.assigned', contact, assignmentVersion]),
    type: 'conversation.assigned',
    contact,
    assignee: agent,
  });
  return true;
}

export async function updateConversationStatus(
  db: Db,
  workspace: string,
  contact: string,
  status: 'open' | 'closed',
): Promise<ConversationDocument | null> {
  const conversations = db.collection<ConversationDocument>('conversations');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updated = await conversations.findOneAndUpdate(
      { workspace, contact, status: { $ne: status } },
      {
        $set: { status, updatedAt: new Date() },
        $inc: { statusVersion: 1 },
      },
      { returnDocument: 'after' },
    );
    const current = updated ?? await conversations.findOne({ workspace, contact });
    if (!current) return null;
    if (current.status !== status) continue;

    if (updated || Number(current.statusVersion ?? 0) > 0) {
      const statusVersion = Number(current.statusVersion ?? 0);
      await appendWorkspaceEvent(db, {
        workspace,
        eventKey: JSON.stringify(['conversation.status', contact, statusVersion]),
        type: 'conversation.status',
        contact,
        conversation_status: status,
      });
    }
    return current;
  }
  throw new Error('Conversation status changed repeatedly while processing the request');
}

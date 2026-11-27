import { Router, type Request, type Response } from 'express';
import { getDb } from './db.js';
import {
  claimConversation,
  ensureConversation,
  updateConversationStatus,
  workspaceExists,
} from './conversation-service.js';
import { sessionFromCookie, sessionWorkspaceRole } from './auth.js';
import { asyncRoute } from './http-utils.js';
import { persistOutboundMessage } from './outbox.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

async function authorizeWorkspace(
  req: Request,
  res: Response,
): Promise<{ workspace: string; sub: string } | null> {
  const session = await sessionFromCookie(req.headers.cookie);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : '';
  if (!isNonEmptyString(workspace, 100)) {
    res.status(400).json({ error: 'workspace_required' });
    return null;
  }
  if (!sessionWorkspaceRole(session, workspace)) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  if (!(await workspaceExists(workspace))) {
    res.status(404).json({ error: 'workspace_not_found' });
    return null;
  }
  return { workspace, sub: session.sub };
}

export const inboxRouter = Router();

inboxRouter.get('/api/conversations', asyncRoute(async (req, res) => {
  const access = await authorizeWorkspace(req, res);
  if (!access) return;
  const db = await getDb();
  const conversations = await db.collection('conversations')
    .find({ workspace: access.workspace })
    .sort({ lastActivityAt: -1, contact: 1 })
    .limit(100)
    .toArray();
  res.status(200).json({ conversations });
}));

inboxRouter.get('/api/conversations/:contact', asyncRoute(async (req, res) => {
  const access = await authorizeWorkspace(req, res);
  if (!access) return;
  const contact = req.params.contact;
  if (!isNonEmptyString(contact, 200)) {
    res.status(400).json({ error: 'invalid_contact' });
    return;
  }
  const db = await getDb();
  const conversation = await db.collection('conversations')
    .findOne({ workspace: access.workspace, contact });
  if (!conversation) {
    res.status(404).json({ error: 'conversation_not_found' });
    return;
  }
  const messages = await db.collection('messages')
    .find({ workspace: access.workspace, contact })
    .sort({ occurredAt: 1, _id: 1 })
    .limit(500)
    .toArray();
  res.status(200).json({ conversation, messages });
}));

inboxRouter.post('/api/conversations/:contact/replies', asyncRoute(async (req, res) => {
  const access = await authorizeWorkspace(req, res);
  if (!access) return;
  const contact = req.params.contact;
  const body: unknown = req.body;
  if (
    !isNonEmptyString(contact, 200) ||
    !isRecord(body) ||
    !isNonEmptyString(body.text, 50_000) ||
    !isNonEmptyString(body.client_ref, 200) ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(body.client_ref)
  ) {
    res.status(400).json({ error: 'invalid_reply' });
    return;
  }
  const db = await getDb();
  const existingJob = await db.collection('outbox').findOne(
    { workspace: access.workspace, clientRef: body.client_ref },
    { projection: { contact: 1 } },
  );
  if (existingJob) {
    if (existingJob.contact !== contact) {
      res.status(409).json({ error: 'client_ref_conflict' });
      return;
    }
    await ensureConversation(access.workspace, contact);
    res.status(202).json({ status: 'queued', client_ref: body.client_ref });
    return;
  }
  const conversation = await db.collection('conversations')
    .findOne({ workspace: access.workspace, contact }, { projection: { status: 1 } });
  if (conversation?.status === 'closed') {
    res.status(409).json({ error: 'conversation_closed' });
    return;
  }
  const persisted = await persistOutboundMessage({
    workspace: access.workspace,
    contact,
    text: body.text,
    clientRef: body.client_ref,
  });
  if (persisted.contact !== contact) {
    res.status(409).json({ error: 'client_ref_conflict' });
    return;
  }
  await ensureConversation(access.workspace, contact);
  res.status(202).json({ status: 'queued', client_ref: body.client_ref });
}));

inboxRouter.post('/api/conversations/:contact/claim', asyncRoute(async (req, res) => {
  const access = await authorizeWorkspace(req, res);
  if (!access) return;
  const contact = req.params.contact;
  if (!isNonEmptyString(contact, 200)) {
    res.status(400).json({ error: 'invalid_contact' });
    return;
  }
  const claimed = await claimConversation(access.workspace, contact, access.sub);
  if (!claimed) {
    res.status(409).json({ error: 'conversation_claimed' });
    return;
  }
  res.status(200).json({ assignee: access.sub });
}));

inboxRouter.patch('/api/conversations/:contact', asyncRoute(async (req, res) => {
  const access = await authorizeWorkspace(req, res);
  if (!access) return;
  const contact = req.params.contact;
  const body: unknown = req.body;
  if (
    !isNonEmptyString(contact, 200) ||
    !isRecord(body) ||
    (body.status !== 'open' && body.status !== 'closed')
  ) {
    res.status(400).json({ error: 'invalid_conversation_status' });
    return;
  }
  const db = await getDb();
  const conversation = await updateConversationStatus(db, access.workspace, contact, body.status);
  if (!conversation) {
    res.status(404).json({ error: 'conversation_not_found' });
    return;
  }
  res.status(200).json({ conversation });
}));

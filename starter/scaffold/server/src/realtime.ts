import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { getDb } from './db.js';
import type { WorkspaceEventDocument } from './events.js';
import { sessionFromCookie, sessionWorkspaceRole } from './auth.js';
import { getRedis } from './redis.js';

type Connection = {
  socket: WebSocket;
  workspace: string;
  lastSent: number;
  active: boolean;
  registered: boolean;
  replaying: boolean;
  draining: boolean;
  needsDrain: boolean;
};

const channelPrefix = 'switchboard:events:';
const connections = new Map<string, Set<Connection>>();
const channelReferences = new Map<string, number>();
const channelSubscriptions = new Map<string, Promise<void>>();
let webSocketServer: WebSocketServer | undefined;
let subscriber: Redis | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let serverInstance: Server | undefined;

function rejectUpgrade(socket: Socket, status: number, message: string): void {
  const phrase = status === 401
    ? 'Unauthorized'
    : status === 403
      ? 'Forbidden'
      : status === 400
        ? 'Bad Request'
        : status === 404
          ? 'Not Found'
          : 'Internal Server Error';
  socket.end(
    `HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\nContent-Type: text/plain\r\n\r\n${message}`,
  );
}

function parseAfter(value: string | null): number | null {
  if (value === null) return 0;
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

async function retainChannel(channel: string): Promise<void> {
  if (!subscriber) throw new Error('Redis event subscriber is unavailable');
  channelReferences.set(channel, (channelReferences.get(channel) ?? 0) + 1);
  let subscription = channelSubscriptions.get(channel);
  if (!subscription) {
    subscription = subscriber.subscribe(channel).then(() => undefined).catch((error: unknown) => {
      channelSubscriptions.delete(channel);
      throw error;
    });
    channelSubscriptions.set(channel, subscription);
  }
  try {
    await subscription;
  } catch (error) {
    const references = channelReferences.get(channel) ?? 0;
    if (references > 1) channelReferences.set(channel, references - 1);
    else channelReferences.delete(channel);
    throw error;
  }
}

async function releaseChannel(channel: string): Promise<void> {
  const references = channelReferences.get(channel) ?? 0;
  if (references > 1) {
    channelReferences.set(channel, references - 1);
    return;
  }
  channelReferences.delete(channel);
  channelSubscriptions.delete(channel);
  if (!subscriber || references === 0) return;
  await subscriber.unsubscribe(channel);
}

function eventFrame(event: WorkspaceEventDocument): Record<string, unknown> {
  return {
    seq: event.seq,
    type: event.type,
    contact: event.contact,
    ...(event.message_id ? { message_id: event.message_id } : {}),
    ...(event.client_ref ? { client_ref: event.client_ref } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.assignee ? { assignee: event.assignee } : {}),
  };
}

async function sendPersistedEvents(connection: Connection): Promise<void> {
  const db = await getDb();
  const cursor = db.collection<WorkspaceEventDocument>('events_websocket')
    .find({ workspace: connection.workspace, seq: { $gt: connection.lastSent } })
    .sort({ seq: 1 });
  try {
    for await (const event of cursor) {
      if (!connection.active || connection.socket.readyState !== WebSocket.OPEN) return;
      if (connection.socket.bufferedAmount > 1_000_000) {
        connection.socket.close(1013, 'Client is too slow');
        return;
      }
      const frame = JSON.stringify(eventFrame(event));
      await new Promise<void>((resolve, reject) => {
        connection.socket.send(frame, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      connection.lastSent = event.seq;
    }
  } finally {
    await cursor.close();
  }
}

async function drain(connection: Connection): Promise<void> {
  if (!connection.active) return;
  if (connection.replaying || connection.draining) {
    connection.needsDrain = true;
    return;
  }
  connection.draining = true;
  try {
    do {
      connection.needsDrain = false;
      await sendPersistedEvents(connection);
    } while (connection.active && connection.needsDrain);
  } catch (error) {
    console.error('[realtime] event delivery failed', error instanceof Error ? error.message : 'unknown error');
    connection.socket.close(1011, 'Event delivery failed');
  } finally {
    connection.draining = false;
  }
}

function notifyWorkspace(workspace: string): void {
  const activeConnections = connections.get(workspace);
  if (!activeConnections) return;
  for (const connection of activeConnections) {
    if (connection.replaying) connection.needsDrain = true;
    else void drain(connection);
  }
}

async function unregister(connection: Connection): Promise<void> {
  if (connection.active) {
    connection.active = false;
    const activeConnections = connections.get(connection.workspace);
    activeConnections?.delete(connection);
    if (activeConnections?.size === 0) connections.delete(connection.workspace);
  }
  if (connection.registered) {
    connection.registered = false;
    try {
      await releaseChannel(`${channelPrefix}${connection.workspace}`);
    } catch (error) {
      console.error('[realtime] unsubscribe failed', error instanceof Error ? error.message : 'unknown error');
    }
  }
}

async function replayAndServe(connection: Connection): Promise<void> {
  const channel = `${channelPrefix}${connection.workspace}`;
  const activeConnections = connections.get(connection.workspace) ?? new Set<Connection>();
  activeConnections.add(connection);
  connections.set(connection.workspace, activeConnections);
  connection.replaying = true;

  try {
    await retainChannel(channel);
    connection.registered = true;
    if (!connection.active) {
      await unregister(connection);
      return;
    }
    do {
      connection.needsDrain = false;
      await sendPersistedEvents(connection);
    } while (connection.active && connection.needsDrain);
    connection.replaying = false;
    if (connection.active) await drain(connection);
  } catch (error) {
    console.error('[realtime] subscription failed', error instanceof Error ? error.message : 'unknown error');
    connection.socket.close(1011, 'Event subscription failed');
    await unregister(connection);
  }
}

async function handleUpgrade(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    rejectUpgrade(socket, 400, 'Invalid request');
    return;
  }
  if (url.pathname !== '/ws') {
    rejectUpgrade(socket, 404, 'Not found');
    return;
  }
  const workspace = url.searchParams.get('workspace');
  const after = parseAfter(url.searchParams.get('after'));
  if (!workspace || workspace.length > 100 || after === null) {
    rejectUpgrade(socket, 400, 'Invalid workspace or sequence');
    return;
  }
  const session = await sessionFromCookie(request.headers.cookie);
  if (!session) {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }
  if (!sessionWorkspaceRole(session, workspace)) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }
  if (!webSocketServer) {
    rejectUpgrade(socket, 503, 'WebSocket service unavailable');
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (client) => {
    const connection: Connection = {
      socket: client,
      workspace,
      lastSent: after,
      active: true,
      registered: false,
      replaying: false,
      draining: false,
      needsDrain: false,
    };
    client.on('close', () => void unregister(connection).catch((error: unknown) => {
      console.error('[realtime] unsubscribe failed', error instanceof Error ? error.message : 'unknown error');
    }));
    client.on('error', () => void unregister(connection).catch((error: unknown) => {
      console.error('[realtime] unsubscribe failed', error instanceof Error ? error.message : 'unknown error');
    }));
    void replayAndServe(connection);
  });
}

const upgradeListener = (request: IncomingMessage, socket: Socket, head: Buffer) => {
  void handleUpgrade(request, socket, head).catch((error: unknown) => {
    console.error('[realtime] upgrade failed', error instanceof Error ? error.message : 'unknown error');
    if (!socket.destroyed) rejectUpgrade(socket, 500, 'Internal server error');
  });
};

export async function initializeRealtime(server: Server): Promise<void> {
  if (webSocketServer) return;
  webSocketServer = new WebSocketServer({ noServer: true });
  subscriber = getRedis().duplicate();
  subscriber.on('message', (channel) => {
    if (channel.startsWith(channelPrefix)) notifyWorkspace(channel.slice(channelPrefix.length));
  });
  subscriber.on('error', (error: Error) => {
    console.error('[realtime] Redis subscriber error', error.message);
  });
  if (subscriber.status === 'wait') await subscriber.connect();
  serverInstance = server;
  serverInstance.on('upgrade', upgradeListener);
  pollTimer = setInterval(() => {
    for (const workspace of connections.keys()) notifyWorkspace(workspace);
  }, 1_000);
}

export async function closeRealtime(): Promise<void> {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  if (serverInstance) serverInstance.off('upgrade', upgradeListener);
  serverInstance = undefined;

  for (const activeConnections of connections.values()) {
    for (const connection of activeConnections) connection.socket.terminate();
  }
  connections.clear();
  channelReferences.clear();
  channelSubscriptions.clear();

  if (subscriber) {
    if (subscriber.status === 'ready') await subscriber.quit();
    else subscriber.disconnect();
  }
  subscriber = undefined;
  if (webSocketServer) {
    await new Promise<void>((resolve) => webSocketServer?.close(() => resolve()));
  }
  webSocketServer = undefined;
}

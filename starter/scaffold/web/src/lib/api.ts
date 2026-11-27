import type { Message, UserSession } from '../types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  if (payload === null) throw new Error('The server returned an invalid response.');
  return payload as T;
}

export function isSession(value: unknown): value is UserSession {
  if (typeof value !== 'object' || value === null || !('sub' in value) || !('workspaces' in value)) {
    return false;
  }
  const candidate = value as { sub: unknown; workspaces: unknown };
  return typeof candidate.sub === 'string' &&
    Array.isArray(candidate.workspaces) &&
    candidate.workspaces.every((membership) =>
      typeof membership === 'object' &&
      membership !== null &&
      'id' in membership &&
      typeof membership.id === 'string' &&
      'role' in membership &&
      (membership.role === 'admin' || membership.role === 'agent'),
    );
}

export function formatTime(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
}

export function statusLabel(status: Message['status']): string {
  if (!status || status === 'received') return '';
  return status;
}

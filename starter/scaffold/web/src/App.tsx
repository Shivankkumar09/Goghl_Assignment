import { useEffect, useRef, useState, type FormEvent } from 'react';
import './App.css';

type Membership = { id: string; role: 'admin' | 'agent' };
type UserSession = { sub: string; workspaces: Membership[] };
type Conversation = {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastActivityAt?: string;
};
type Message = {
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status?: 'received' | 'queued' | 'sent' | 'delivered' | 'failed';
  occurredAt: string;
  providerMessageId?: string;
  clientRef?: string;
};
type ConversationListResponse = { conversations: Conversation[] };
type ConversationDetailResponse = { conversation: Conversation; messages: Message[] };

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
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

function isSession(value: unknown): value is UserSession {
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

function formatTime(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function formatDate(value: string): string {
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

function statusLabel(status: Message['status']): string {
  if (!status || status === 'received') return '';
  return status;
}

export function App() {
  const [identity, setIdentity] = useState<UserSession | null>(null);
  const [authState, setAuthState] = useState<'loading' | 'signedOut' | 'ready' | 'error'>('loading');
  const [authError, setAuthError] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedContact, setSelectedContact] = useState('');
  const [detail, setDetail] = useState<ConversationDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  const lastSequence = useRef(new Map<string, number>());
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const historyElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    requestJson<unknown>('/api/me')
      .then((result) => {
        if (!active) return;
        if (!isSession(result)) throw new Error('The server returned an invalid session.');
        setIdentity(result);
        setAuthState('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) {
          setAuthState('signedOut');
          return;
        }
        setAuthError(error instanceof Error ? error.message : 'Could not load your session.');
        setAuthState('error');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!identity) return;
    if (!identity.workspaces.some((membership) => membership.id === workspace)) {
      setWorkspace(identity.workspaces[0]?.id ?? '');
      setSelectedContact('');
    }
  }, [identity, workspace]);

  useEffect(() => {
    if (!workspace) {
      setConversations([]);
      setSelectedContact('');
      return;
    }
    let active = true;
    const requestId = ++listRequest.current;
    setListLoading(true);
    setListError('');
    requestJson<ConversationListResponse>(`/api/conversations?workspace=${encodeURIComponent(workspace)}`)
      .then((result) => {
        if (!active || requestId !== listRequest.current) return;
        const items = Array.isArray(result.conversations) ? result.conversations : [];
        setConversations(items);
        setSelectedContact((current) =>
          current && items.some((conversation) => conversation.contact === current)
            ? current
            : items[0]?.contact ?? '',
        );
      })
      .catch((error: unknown) => {
        if (!active || requestId !== listRequest.current) return;
        if (error instanceof ApiError && error.status === 401) {
          setIdentity(null);
          setAuthState('signedOut');
          return;
        }
        setListError(error instanceof Error ? error.message : 'Could not load conversations.');
      })
      .finally(() => {
        if (active && requestId === listRequest.current) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspace, refreshVersion]);

  useEffect(() => {
    if (!workspace || !selectedContact) {
      setDetail(null);
      setDetailError('');
      setDetailLoading(false);
      return;
    }
    let active = true;
    const requestId = ++detailRequest.current;
    setDetailLoading(true);
    setDetailError('');
    const query = new URLSearchParams({ workspace });
    requestJson<ConversationDetailResponse>(
      `/api/conversations/${encodeURIComponent(selectedContact)}?${query.toString()}`,
    )
      .then((result) => {
        if (active && requestId === detailRequest.current) setDetail(result);
      })
      .catch((error: unknown) => {
        if (!active || requestId !== detailRequest.current) return;
        if (error instanceof ApiError && error.status === 401) {
          setIdentity(null);
          setAuthState('signedOut');
          return;
        }
        setDetailError(error instanceof Error ? error.message : 'Could not load this conversation.');
      })
      .finally(() => {
        if (active && requestId === detailRequest.current) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspace, selectedContact, refreshVersion]);

  useEffect(() => {
    const history = historyElement.current;
    if (history) history.scrollTop = history.scrollHeight;
  }, [detail]);

  useEffect(() => {
    if (!identity || !workspace) return;
    let active = true;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    const connect = () => {
      if (!active) return;
      setConnection(retries === 0 ? 'connecting' : 'reconnecting');
      const after = lastSequence.current.get(workspace) ?? 0;
      const query = new URLSearchParams({ workspace, after: String(after) });
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws?${query.toString()}`);
      socket.onopen = () => {
        if (!active) return;
        setConnection('connected');
        setRefreshVersion((value) => value + 1);
        stableTimer = setTimeout(() => {
          retries = 0;
        }, 10_000);
      };
      socket.onmessage = (message) => {
        if (!active || typeof message.data !== 'string') return;
        try {
          const event: unknown = JSON.parse(message.data);
          if (
            typeof event !== 'object' ||
            event === null ||
            !('seq' in event) ||
            typeof event.seq !== 'number' ||
            !Number.isSafeInteger(event.seq)
          ) {
            return;
          }
          const previous = lastSequence.current.get(workspace) ?? 0;
          if (event.seq <= previous) return;
          lastSequence.current.set(workspace, event.seq);
          if (refreshTimer) clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => {
            if (active) setRefreshVersion((value) => value + 1);
          }, 120);
        } catch {
          setActionError('Received an unreadable real-time update. The inbox will refresh on reconnect.');
        }
      };
      socket.onclose = () => {
        if (!active) return;
        if (stableTimer) clearTimeout(stableTimer);
        setConnection('reconnecting');
        void requestJson<unknown>('/api/me').catch((error: unknown) => {
          if (active && error instanceof ApiError && error.status === 401) {
            setIdentity(null);
            setAuthState('signedOut');
          }
        });
        const delay = Math.min(500 * 2 ** Math.min(retries, 6), 30_000);
        retries += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (stableTimer) clearTimeout(stableTimer);
      socket?.close();
    };
  }, [identity, workspace]);

  async function performAction(path: string, init: RequestInit): Promise<boolean> {
    setActionError('');
    try {
      await requestJson<unknown>(path, init);
      setRefreshVersion((value) => value + 1);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setIdentity(null);
        setAuthState('signedOut');
      }
      setActionError(error instanceof Error ? error.message : 'The action failed.');
      return false;
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !workspace || !selectedContact || sending) return;
    setSending(true);
    const query = new URLSearchParams({ workspace });
    const succeeded = await performAction(
      `/api/conversations/${encodeURIComponent(selectedContact)}/replies?${query.toString()}`,
      {
        method: 'POST',
        body: JSON.stringify({ text, client_ref: window.crypto.randomUUID() }),
      },
    );
    if (succeeded) setDraft('');
    setSending(false);
  }

  async function claimConversation() {
    if (!workspace || !selectedContact) return;
    const query = new URLSearchParams({ workspace });
    await performAction(
      `/api/conversations/${encodeURIComponent(selectedContact)}/claim?${query.toString()}`,
      { method: 'POST' },
    );
  }

  async function toggleConversationStatus() {
    if (!workspace || !selectedContact || !detail) return;
    const query = new URLSearchParams({ workspace });
    await performAction(
      `/api/conversations/${encodeURIComponent(selectedContact)}?${query.toString()}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: detail.conversation.status === 'open' ? 'closed' : 'open' }),
      },
    );
  }

  const visibleConversations = conversations.filter((conversation) => {
    const matchesSearch = conversation.contact.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === 'all' || conversation.status === filter;
    return matchesSearch && matchesFilter;
  });

  if (authState === 'loading') {
    return (
      <main className="auth-page">
        <div className="auth-card"><span className="brand-mark">S</span><p>Checking your session…</p></div>
      </main>
    );
  }

  if (authState === 'error') {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <span className="brand-mark">S</span>
          <h1>Switchboard</h1>
          <p className="muted">We couldn’t connect to your inbox.</p>
          <p className="error-text">{authError}</p>
          <button className="button button-primary" onClick={() => window.location.reload()}>Try again</button>
        </section>
      </main>
    );
  }

  if (authState === 'signedOut' || !identity) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <span className="brand-mark">S</span>
          <h1>Switchboard</h1>
          <p className="muted">A shared inbox for your support team.</p>
          {authError && <p className="error-text">{authError}</p>}
          <a className="button button-primary login-button" href="/auth/login">Sign in</a>
        </section>
      </main>
    );
  }

  const selectedMembership = identity.workspaces.find((membership) => membership.id === workspace);
  const currentConversation = detail?.conversation;
  const assignedToMe = currentConversation?.assignee === identity.sub;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Switchboard home">
          <span className="brand-mark">S</span>
          <span>switchboard</span>
        </a>
        <div className="topbar-controls">
          <label className="workspace-picker">
            <span className="sr-only">Workspace</span>
            <select
              value={workspace}
              onChange={(event) => {
                setWorkspace(event.target.value);
                setSelectedContact('');
                setDetail(null);
                setActionError('');
              }}
              aria-label="Select workspace"
            >
              {identity.workspaces.map((membership) => (
                <option key={membership.id} value={membership.id}>{membership.id}</option>
              ))}
            </select>
          </label>
          <div className="user-chip" title={`${identity.sub} · ${selectedMembership?.role ?? ''}`}>
            <span className="user-avatar">{identity.sub.slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{identity.sub}</span>
          </div>
        </div>
      </header>

      <div className="inbox-layout">
        <aside className="conversation-sidebar">
          <div className="sidebar-heading">
            <div>
              <p className="eyebrow">WORKSPACE INBOX</p>
              <h1>Conversations</h1>
            </div>
            <span className="count-badge">{conversations.length}</span>
          </div>
          <div className="inbox-tools">
            <label className="search-box">
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                placeholder="Search contacts"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search contacts"
              />
            </label>
            <div className="filter-tabs" role="group" aria-label="Conversation status filter">
              {(['all', 'open', 'closed'] as const).map((value) => (
                <button
                  key={value}
                  className={filter === value ? 'filter-tab active' : 'filter-tab'}
                  onClick={() => setFilter(value)}
                >
                  {value === 'all' ? 'All' : value === 'open' ? 'Open' : 'Closed'}
                </button>
              ))}
            </div>
          </div>
          {listError && <div className="inline-error">{listError}</div>}
          <div className="conversation-list" aria-live="polite">
            {listLoading && conversations.length === 0 ? (
              <div className="list-state">Loading conversations…</div>
            ) : visibleConversations.length === 0 ? (
              <div className="list-state">
                <span className="empty-icon">✳</span>
                <strong>{search || filter !== 'all' ? 'No matches' : 'No conversations yet'}</strong>
                <span>New customer messages will appear here.</span>
              </div>
            ) : (
              visibleConversations.map((conversation) => (
                <button
                  className={selectedContact === conversation.contact ? 'conversation-row selected' : 'conversation-row'}
                  key={conversation.contact}
                  onClick={() => {
                    setSelectedContact(conversation.contact);
                    setActionError('');
                  }}
                >
                  <span className="contact-avatar">{conversation.contact.slice(-2)}</span>
                  <span className="conversation-copy">
                    <span className="conversation-title">
                      <strong>{conversation.contact}</strong>
                      <time>{formatTime(conversation.lastActivityAt)}</time>
                    </span>
                    <span className="conversation-meta">
                      <span>{conversation.assignee ? `Assigned · ${conversation.assignee}` : 'Unassigned'}</span>
                      <span className={`status-dot ${conversation.status}`} />
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="sidebar-footer">
            <span className={`connection-dot ${connection}`} />
            <span>{connection === 'connected' ? 'Live updates on' : connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
          </div>
        </aside>

        <section className="conversation-panel" aria-label="Selected conversation">
          {!selectedContact ? (
            <div className="welcome-state">
              <span className="welcome-mark">S</span>
              <h2>Your team inbox</h2>
              <p>Select a conversation to view its history and reply.</p>
            </div>
          ) : detailLoading && !detail ? (
            <div className="panel-state">Loading conversation…</div>
          ) : detailError ? (
            <div className="panel-state">
              <p className="error-text">{detailError}</p>
              <button className="button button-secondary" onClick={() => setRefreshVersion((value) => value + 1)}>Retry</button>
            </div>
          ) : currentConversation ? (
            <>
              <div className="conversation-header">
                <div className="contact-heading">
                  <span className="contact-avatar large">{currentConversation.contact.slice(-2)}</span>
                  <div>
                    <h2>{currentConversation.contact}</h2>
                    <p>
                      {currentConversation.assignee
                        ? `Assigned to ${currentConversation.assignee}`
                        : 'No assignee'}
                      <span className={`status-pill ${currentConversation.status}`}>{currentConversation.status}</span>
                    </p>
                  </div>
                </div>
                <div className="conversation-actions">
                  {!currentConversation.assignee ? (
                    <button className="button button-secondary" onClick={() => void claimConversation()}>
                      Claim conversation
                    </button>
                  ) : assignedToMe ? (
                    <span className="assigned-label">Assigned to you</span>
                  ) : (
                    <span className="assigned-label">Claimed by {currentConversation.assignee}</span>
                  )}
                  <button className="button button-quiet" onClick={() => void toggleConversationStatus()}>
                    {currentConversation.status === 'open' ? 'Close' : 'Reopen'}
                  </button>
                </div>
              </div>

              {actionError && <div className="action-banner" role="alert">{actionError}</div>}

              <div className="message-history" aria-live="polite" ref={historyElement}>
                {detail?.messages.length ? (
                  <>
                    <div className="history-divider"><span>Conversation history</span></div>
                    {detail.messages.map((message, index) => (
                      <article
                        className={`message-row ${message.direction}`}
                        key={message.providerMessageId ?? message.clientRef ?? `${message.occurredAt}-${index}`}
                      >
                        {message.direction === 'inbound' && <span className="message-avatar">C</span>}
                        <div className="message-content">
                          <div className="message-meta">
                            <strong>{message.direction === 'inbound' ? 'Customer' : 'You'}</strong>
                            <time>{formatDate(message.occurredAt)}</time>
                          </div>
                          <div className="message-bubble">{message.text}</div>
                          {message.direction === 'outbound' && message.status && (
                            <span className={`delivery-status ${message.status}`}>{statusLabel(message.status)}</span>
                          )}
                        </div>
                      </article>
                    ))}
                  </>
                ) : (
                  <div className="history-empty">No messages yet. Send the first reply to start the conversation.</div>
                )}
              </div>

              <form className="reply-composer" onSubmit={(event) => void sendReply(event)}>
                <label className="sr-only" htmlFor="reply-text">Write a reply</label>
                <textarea
                  id="reply-text"
                  placeholder={currentConversation.status === 'closed' ? 'Reopen this conversation to reply' : 'Write a reply…'}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={sending || currentConversation.status === 'closed'}
                  rows={3}
                />
                <div className="composer-footer">
                  <span>Replies are sent to the customer.</span>
                  <button
                    className="button button-primary send-button"
                    type="submit"
                    disabled={sending || !draft.trim() || currentConversation.status === 'closed'}
                  >
                    {sending ? 'Sending…' : 'Send reply'}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <div className="panel-state">Choose a conversation from the inbox.</div>
          )}
        </section>
      </div>
    </main>
  );
}

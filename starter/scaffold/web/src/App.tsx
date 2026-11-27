import { useEffect, useRef, useState } from 'react';
import { AuthScreen } from './components/AuthScreen';
import { ConversationPanel } from './components/ConversationPanel';
import { InboxSidebar } from './components/InboxSidebar';
import { ApiError, isSession, requestJson } from './lib/api';
import type {
  ConnectionState,
  Conversation,
  ConversationDetailResponse,
  ConversationListResponse,
  UserSession,
} from './types';
import './App.css';

export function App() {
  const [identity, setIdentity] = useState<UserSession | null>(null);
  const [authState, setAuthState] = useState<'loading' | 'signedOut' | 'ready' | 'error'>('loading');
  const [authError, setAuthError] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [selectedContact, setSelectedContact] = useState('');
  const [detail, setDetail] = useState<ConversationDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const lastSequence = useRef(new Map<string, number>());
  const listRequest = useRef(0);
  const detailRequest = useRef(0);

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

  async function sendReply() {
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

  if (authState !== 'ready' || !identity) {
    return (
      <AuthScreen
        state={authState === 'ready' ? 'signedOut' : authState}
        error={authError}
        onRetry={() => window.location.reload()}
      />
    );
  }

  const selectedMembership = identity.workspaces.find((membership) => membership.id === workspace);

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
        <InboxSidebar
          conversations={conversations}
          listLoading={listLoading}
          listError={listError}
          connection={connection}
          selectedContact={selectedContact}
          onSelectContact={(contact) => {
            setSelectedContact(contact);
            setActionError('');
          }}
        />
        <ConversationPanel
          selectedContact={selectedContact}
          detail={detail}
          detailLoading={detailLoading}
          detailError={detailError}
          identity={identity}
          draft={draft}
          onDraftChange={setDraft}
          sending={sending}
          actionError={actionError}
          onClaim={() => void claimConversation()}
          onToggleStatus={() => void toggleConversationStatus()}
          onSendReply={() => void sendReply()}
          onRetry={() => setRefreshVersion((value) => value + 1)}
        />
      </div>
    </main>
  );
}

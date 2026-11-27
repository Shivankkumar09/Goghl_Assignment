import { useState } from 'react';
import { formatTime } from '../lib/api';
import type { ConnectionState, Conversation } from '../types';

type InboxSidebarProps = {
  conversations: Conversation[];
  listLoading: boolean;
  listError: string;
  connection: ConnectionState;
  selectedContact: string;
  onSelectContact: (contact: string) => void;
};

export function InboxSidebar({
  conversations,
  listLoading,
  listError,
  connection,
  selectedContact,
  onSelectContact,
}: InboxSidebarProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  const visibleConversations = conversations.filter((conversation) => {
    const matchesSearch = conversation.contact.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === 'all' || conversation.status === filter;
    return matchesSearch && matchesFilter;
  });

  return (
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
              onClick={() => onSelectContact(conversation.contact)}
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
  );
}

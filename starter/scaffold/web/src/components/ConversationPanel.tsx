import { useEffect, useRef } from 'react';
import { formatDate, statusLabel } from '../lib/api';
import type { ConversationDetailResponse, UserSession } from '../types';

type ConversationPanelProps = {
  selectedContact: string;
  detail: ConversationDetailResponse | null;
  detailLoading: boolean;
  detailError: string;
  identity: UserSession;
  draft: string;
  onDraftChange: (draft: string) => void;
  sending: boolean;
  actionError: string;
  onClaim: () => void;
  onToggleStatus: () => void;
  onSendReply: () => void;
  onRetry: () => void;
};

export function ConversationPanel({
  selectedContact,
  detail,
  detailLoading,
  detailError,
  identity,
  draft,
  onDraftChange,
  sending,
  actionError,
  onClaim,
  onToggleStatus,
  onSendReply,
  onRetry,
}: ConversationPanelProps) {
  const historyElement = useRef<HTMLDivElement>(null);
  const currentConversation = detail?.conversation;
  const assignedToMe = currentConversation?.assignee === identity.sub;

  useEffect(() => {
    const history = historyElement.current;
    if (history) history.scrollTop = history.scrollHeight;
  }, [detail]);

  return (
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
          <button className="button button-secondary" onClick={onRetry}>Retry</button>
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
                <button className="button button-secondary" onClick={onClaim}>
                  Claim conversation
                </button>
              ) : assignedToMe ? (
                <span className="assigned-label">Assigned to you</span>
              ) : (
                <span className="assigned-label">Claimed by {currentConversation.assignee}</span>
              )}
              <button className="button button-quiet" onClick={onToggleStatus}>
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

          <form
            className="reply-composer"
            onSubmit={(event) => {
              event.preventDefault();
              onSendReply();
            }}
          >
            <label className="sr-only" htmlFor="reply-text">Write a reply</label>
            <textarea
              id="reply-text"
              placeholder={currentConversation.status === 'closed' ? 'Reopen this conversation to reply' : 'Write a reply…'}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
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
  );
}

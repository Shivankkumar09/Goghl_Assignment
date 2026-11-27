export type Membership = { id: string; role: 'admin' | 'agent' };
export type UserSession = { sub: string; workspaces: Membership[] };
export type Conversation = {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastActivityAt?: string;
};
export type Message = {
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status?: 'received' | 'queued' | 'sent' | 'delivered' | 'failed';
  occurredAt: string;
  providerMessageId?: string;
  clientRef?: string;
};
export type ConversationListResponse = { conversations: Conversation[] };
export type ConversationDetailResponse = { conversation: Conversation; messages: Message[] };
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting';

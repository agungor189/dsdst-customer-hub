import type { Capability, ChannelType } from "../../../shared/contracts/domain.js";
import type Database from "better-sqlite3";

export type NormalizedInboundMessage = {
  eventId: string; externalAccountId: string; externalConversationId: string; externalMessageId: string;
  externalUserId: string; displayName: string; username?: string; body: string; subject?: string;
  email?: string; phone?: string; messageType: string; externalCreatedAt: string; metadata: Record<string, unknown>;
};
export type OutboundEnvelope = { messageId: string; externalConversationId: string; body: string; metadata: Record<string, unknown> };
export type SendResult = { externalMessageId: string; status: "SENT" | "DELIVERED" };
export type ChannelAccountContext = {
  id: string;
  externalAccountId: string;
  credentials: Record<string, string> | null;
};
export type ChannelSyncContext = ChannelAccountContext & { db: Database.Database };
export type ReplyValidationContext = ChannelAccountContext & {
  db: Database.Database;
  phase: "QUEUE" | "SEND";
};
export type NormalizedMessageStatus = {
  eventId: string;
  externalAccountId: string;
  externalMessageId: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  externalCreatedAt: string;
  metadata: Record<string, unknown>;
};
export type NormalizedWebhookBatch = {
  messages: NormalizedInboundMessage[];
  statuses: NormalizedMessageStatus[];
};

export interface ChannelAdapter {
  readonly channelType: ChannelType;
  readonly capabilities: ReadonlySet<Capability>;
  validateConfiguration(credentials: Record<string,string> | null, externalAccountId?: string): { valid: boolean; errors: string[] };
  validateReply?(envelope: OutboundEnvelope, context: ReplyValidationContext): void;
  sendMessage(envelope: OutboundEnvelope, account: ChannelAccountContext): Promise<SendResult>;
  handleWebhook?(payload: unknown): NormalizedWebhookBatch;
  syncConversations?(context: ChannelSyncContext): Promise<void>;
  syncMessages?(context: ChannelSyncContext): Promise<void>;
  markRead?(externalMessageId: string, account: ChannelAccountContext): Promise<void>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly code: string) { super(message); }
}

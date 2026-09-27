import type { Capability, ChannelType } from "../../../shared/contracts/domain.js";
import type Database from "better-sqlite3";

export type NormalizedInboundMessage = {
  eventId: string; externalAccountId: string; externalConversationId: string; externalMessageId: string;
  externalUserId: string; displayName: string; username?: string; body: string; subject?: string;
  messageType: string; externalCreatedAt: string; metadata: Record<string, unknown>;
};
export type OutboundEnvelope = { messageId: string; externalConversationId: string; body: string; metadata: Record<string, unknown> };
export type SendResult = { externalMessageId: string; status: "SENT" | "DELIVERED" };
export type ChannelAccountContext = {
  id: string;
  externalAccountId: string;
  credentials: Record<string, string> | null;
};
export type ChannelSyncContext = ChannelAccountContext & { db: Database.Database };

export interface ChannelAdapter {
  readonly channelType: ChannelType;
  readonly capabilities: ReadonlySet<Capability>;
  validateConfiguration(credentials: Record<string,string> | null): { valid: boolean; errors: string[] };
  sendMessage(envelope: OutboundEnvelope, account: ChannelAccountContext): Promise<SendResult>;
  handleWebhook?(payload: unknown): NormalizedInboundMessage[];
  syncConversations?(context: ChannelSyncContext): Promise<void>;
  syncMessages?(context: ChannelSyncContext): Promise<void>;
  markRead?(): Promise<void>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly code: string) { super(message); }
}

import { z } from "zod";
import { channelTypes, conversationStatuses, priorities } from "../contracts/domain.js";

export const loginSchema = z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(500) });
export const conversationQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  channel: z.enum(channelTypes).optional(),
  status: z.enum(conversationStatuses).optional(),
  priority: z.enum(priorities).optional(),
  assigned: z.string().max(100).optional(),
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const replySchema = z.object({ body: z.string().trim().min(1).max(20_000), client_message_id: z.string().uuid() });
export const noteSchema = z.object({ text: z.string().trim().min(1).max(10_000) });
export const assignmentSchema = z.object({ assigned_user_id: z.string().min(1).max(100).nullable() });
export const statusSchema = z.object({ status: z.enum(conversationStatuses) });
export const tagSchema = z.object({ name: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#64748b") });
export const inboundSchema = z.object({
  event_id: z.string().min(1).max(250),
  external_account_id: z.string().min(1).max(250),
  external_conversation_id: z.string().min(1).max(250),
  external_message_id: z.string().min(1).max(250),
  external_user_id: z.string().min(1).max(250),
  display_name: z.string().trim().min(1).max(250),
  username: z.string().max(250).optional(),
  body: z.string().max(50_000),
  subject: z.string().max(500).optional(),
  message_type: z.string().max(80).default("TEXT"),
  external_created_at: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export const mergeSchema = z.object({ source_contact_id: z.string().uuid(), target_contact_id: z.string().uuid() });
export const channelAccountSchema = z.object({
  channel_type: z.enum(channelTypes),
  name: z.string().trim().min(1).max(120),
  external_account_id: z.string().trim().min(1).max(250),
  credentials: z.record(z.string(), z.string()).optional(),
  polling_interval_seconds: z.number().int().min(60).max(86_400).optional(),
});

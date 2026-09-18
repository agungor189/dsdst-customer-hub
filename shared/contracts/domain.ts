export const channelTypes = [
  "META_INSTAGRAM", "META_FACEBOOK", "META_WHATSAPP", "EMAIL", "WEBSITE",
  "TRENDYOL", "N11", "MANUAL_EXTERNAL",
] as const;
export type ChannelType = (typeof channelTypes)[number];

export const conversationStatuses = ["NEW", "OPEN", "WAITING_CUSTOMER", "WAITING_INTERNAL", "RESOLVED", "CLOSED", "SPAM"] as const;
export type ConversationStatus = (typeof conversationStatuses)[number];
export const priorities = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type Priority = (typeof priorities)[number];
export const messageStatuses = ["RECEIVED", "QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "FAILED"] as const;

export const capabilities = [
  "READ_MESSAGES", "SEND_MESSAGES", "WEBHOOK", "POLLING", "ATTACHMENTS",
  "MARK_READ", "TYPING", "CUSTOMER_PROFILE", "PRODUCT_QUESTIONS",
] as const;
export type Capability = (typeof capabilities)[number];

export const permissions = [
  "customer_hub:view", "customer_hub:reply", "customer_hub:assign",
  "customer_hub:manage_channels", "customer_hub:manage_tags", "customer_hub:view_customer_context",
] as const;
export type CustomerHubPermission = (typeof permissions)[number];

export type PanelUser = {
  id: string;
  username: string;
  role: "admin" | "user" | "readonly";
  permissions: Record<string, unknown>;
  must_change_password?: boolean;
};

export type InboxConversation = {
  id: string;
  channel_type: ChannelType;
  channel_name: string;
  contact_id: string;
  display_name: string;
  subject: string | null;
  status: ConversationStatus;
  priority: Priority;
  assigned_user_id: string | null;
  last_message_at: string;
  unread_count: number;
  external_url: string | null;
  last_message: string | null;
  tags: Array<{ id: string; name: string; color: string }>;
};

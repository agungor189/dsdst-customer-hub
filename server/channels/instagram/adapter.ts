import type { Capability } from "../../../shared/contracts/domain.js";
import type {
  ChannelAccountContext,
  ChannelAdapter,
  NormalizedInboundMessage,
  NormalizedWebhookBatch,
  OutboundEnvelope,
  ReplyValidationContext,
  SendResult,
} from "../core/types.js";
import { ProviderError } from "../core/types.js";
import { asRecord, MetaTransport, providerTimestamp, safeDefined } from "../meta/transport.js";

const GRAPH_ORIGIN = "https://graph.instagram.com";
const capabilities: ReadonlySet<Capability> = new Set([
  "READ_MESSAGES", "SEND_MESSAGES", "WEBHOOK", "ATTACHMENTS", "CUSTOMER_PROFILE",
]);

type InstagramCredentials = { access_token: string; ig_account_id: string; graph_api_version: string };
type AdapterOptions = { timeoutMs: number; fetch?: typeof fetch; now?: () => number };

function attachmentContent(message: Record<string, any>) {
  const attachment = (Array.isArray(message.attachments) ? message.attachments : []).map(asRecord)[0];
  const shares = (Array.isArray(message.shares) ? message.shares : []).map(asRecord);
  if (!attachment && !shares.length) return null;
  if (shares.length) {
    const share = shares[0];
    return { body: "[Paylaşım]", messageType: "SHARE", metadata: safeDefined({ attachment_type: "share", provider_attachment_id: share.id, attachment_url: share.link ?? share.url, attachment_title: share.title }) };
  }
  const type = String(attachment.type ?? "file").toLowerCase();
  const mapping: Record<string, { body: string; messageType: string }> = {
    image: { body: "[Görsel]", messageType: "IMAGE" }, video: { body: "[Video]", messageType: "VIDEO" },
    audio: { body: "[Ses]", messageType: "AUDIO" }, file: { body: "[Belge]", messageType: "DOCUMENT" },
    document: { body: "[Belge]", messageType: "DOCUMENT" }, sticker: { body: "[Sticker]", messageType: "STICKER" },
    share: { body: "[Paylaşım]", messageType: "SHARE" },
  };
  const selected = mapping[type] ?? { body: `[${type}]`, messageType: type.toUpperCase() };
  const payload = asRecord(attachment.payload);
  return { ...selected, metadata: safeDefined({ attachment_type: type, provider_attachment_id: attachment.id ?? payload.id ?? payload.sticker_id, attachment_url: payload.url, attachment_title: attachment.title ?? payload.title }) };
}

export function normalizeInstagramWebhook(payload: unknown, nowMs = Date.now()): NormalizedWebhookBatch {
  const messages: NormalizedInboundMessage[] = [];
  const root = asRecord(payload);
  if (root.object !== "instagram") return { messages, statuses: [] };
  for (const entryValue of Array.isArray(root.entry) ? root.entry : []) {
    const entry = asRecord(entryValue);
    const entryAccountId = String(entry.id ?? "").trim();
    for (const eventValue of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const event = asRecord(eventValue);
      const senderId = String(asRecord(event.sender).id ?? "").trim();
      const recipientId = String(asRecord(event.recipient).id ?? "").trim();
      const accountId = entryAccountId || recipientId;
      const message = asRecord(event.message);
      const mid = String(message.mid ?? "").trim();
      if (!mid || !senderId || !accountId || message.is_echo === true || senderId === accountId) continue;
      const attachment = attachmentContent(message);
      const text = typeof message.text === "string" ? message.text : "";
      const replyTo = asRecord(message.reply_to);
      const storyMention = asRecord(message.story_mention);
      messages.push({
        eventId: `instagram:${accountId}:${mid}`,
        externalAccountId: accountId,
        externalConversationId: senderId,
        externalMessageId: mid,
        externalUserId: senderId,
        displayName: typeof event.sender_name === "string" ? event.sender_name : "Instagram Müşterisi",
        body: text || attachment?.body || "[Mesaj]",
        messageType: text ? "TEXT" : attachment?.messageType ?? "UNKNOWN",
        externalCreatedAt: providerTimestamp(event.timestamp, nowMs),
        metadata: {
          provider: "meta_instagram",
          instagram_scoped_id: senderId,
          ig_account_id: accountId,
          message_type: text ? "text" : attachment ? String(attachment.metadata.attachment_type) : "unknown",
          ...safeDefined({ reply_to_mid: replyTo.mid, story_mention_url: storyMention.url }),
          ...(attachment?.metadata ?? {}),
        },
      });
    }
  }
  return { messages, statuses: [] };
}

export class InstagramMessagingAdapter implements ChannelAdapter {
  readonly channelType = "META_INSTAGRAM" as const;
  readonly capabilities = capabilities;
  private readonly transport: MetaTransport;
  private readonly now: () => number;

  constructor(options: AdapterOptions) {
    this.transport = new MetaTransport(options);
    this.now = options.now ?? Date.now;
  }

  validateConfiguration(credentials: Record<string, string> | null, externalAccountId?: string) {
    const accountId = credentials?.ig_account_id?.trim() || credentials?.account_id?.trim();
    const errors: string[] = [];
    if (!credentials?.access_token?.trim()) errors.push("access_token is required");
    if (!accountId) errors.push("ig_account_id is required");
    if (!credentials?.graph_api_version?.trim()) errors.push("graph_api_version is required");
    if (credentials?.graph_api_version && !/^v\d+\.\d+$/.test(credentials.graph_api_version.trim())) errors.push("graph_api_version must use vXX.X format");
    if (externalAccountId && accountId && accountId !== externalAccountId) errors.push("ig_account_id must match external_account_id");
    return { valid: errors.length === 0, errors };
  }

  validateReply(envelope: OutboundEnvelope, context: ReplyValidationContext): void {
    const row = context.db.prepare(`SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.channel_account_id=? AND c.channel_account_id=? AND c.external_conversation_id=? AND m.direction='INBOUND' LIMIT 1`)
      .get(context.id, context.id, envelope.externalConversationId);
    if (!row) throw new ProviderError("Instagram conversation has not been initiated by the customer", false, "INSTAGRAM_CONVERSATION_NOT_STARTED");
  }

  handleWebhook(payload: unknown) { return normalizeInstagramWebhook(payload, this.now()); }

  async sendMessage(envelope: OutboundEnvelope, account: ChannelAccountContext): Promise<SendResult> {
    const credentials = this.credentials(account);
    const response = await this.transport.post(GRAPH_ORIGIN, credentials.graph_api_version, credentials.ig_account_id, "messages", credentials.access_token, {
      recipient: { id: envelope.externalConversationId }, message: { text: envelope.body },
    });
    const id = String(response.message_id ?? "").trim();
    if (!id) throw new ProviderError("Instagram response is missing a message id", true, "PROVIDER_UNAVAILABLE");
    return { externalMessageId: id, status: "SENT" };
  }

  private credentials(account: ChannelAccountContext): InstagramCredentials {
    const value = account.credentials;
    const validation = this.validateConfiguration(value, account.externalAccountId);
    if (!validation.valid || !value) {
      const mismatch = validation.errors.some(item => item.includes("external_account_id"));
      throw new ProviderError("Instagram account is not configured", false, mismatch ? "ACCOUNT_CONFIGURATION_MISMATCH" : "NOT_CONFIGURED");
    }
    return {
      access_token: value.access_token,
      ig_account_id: (value.ig_account_id || value.account_id).trim(),
      graph_api_version: value.graph_api_version.trim(),
    };
  }
}

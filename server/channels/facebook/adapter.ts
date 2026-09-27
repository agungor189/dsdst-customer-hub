import type { Capability } from "../../../shared/contracts/domain.js";
import type {
  ChannelAccountContext,
  ChannelAdapter,
  NormalizedInboundMessage,
  NormalizedMessageStatus,
  NormalizedWebhookBatch,
  OutboundEnvelope,
  ReplyValidationContext,
  SendResult,
} from "../core/types.js";
import { ProviderError } from "../core/types.js";
import { asRecord, MetaTransport, providerTimestamp, safeDefined } from "../meta/transport.js";

const GRAPH_ORIGIN = "https://graph.facebook.com";
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const capabilities: ReadonlySet<Capability> = new Set([
  "READ_MESSAGES", "SEND_MESSAGES", "WEBHOOK", "ATTACHMENTS", "MARK_READ", "CUSTOMER_PROFILE",
]);

type FacebookCredentials = { access_token: string; page_id: string; graph_api_version: string };
type AdapterOptions = { timeoutMs: number; fetch?: typeof fetch; now?: () => number };

function attachmentContent(message: Record<string, any>) {
  const attachment = (Array.isArray(message.attachments) ? message.attachments : []).map(asRecord)[0];
  if (!attachment) return null;
  const type = String(attachment.type ?? "file").toLowerCase();
  const mapping: Record<string, { body: string; messageType: string }> = {
    image: { body: "[Görsel]", messageType: "IMAGE" },
    video: { body: "[Video]", messageType: "VIDEO" },
    audio: { body: "[Ses]", messageType: "AUDIO" },
    file: { body: "[Belge]", messageType: "DOCUMENT" },
    document: { body: "[Belge]", messageType: "DOCUMENT" },
    sticker: { body: "[Sticker]", messageType: "STICKER" },
    fallback: { body: "[Paylaşım]", messageType: "SHARE" },
    share: { body: "[Paylaşım]", messageType: "SHARE" },
  };
  const selected = mapping[type] ?? { body: `[${type}]`, messageType: type.toUpperCase() };
  const payload = asRecord(attachment.payload);
  return {
    ...selected,
    metadata: safeDefined({
      attachment_type: type,
      provider_attachment_id: attachment.id ?? payload.id ?? payload.sticker_id,
      attachment_url: payload.url,
      attachment_title: attachment.title ?? payload.title,
    }),
  };
}

export function normalizeFacebookWebhook(payload: unknown, nowMs = Date.now()): NormalizedWebhookBatch {
  const messages: NormalizedInboundMessage[] = [];
  const statuses: NormalizedMessageStatus[] = [];
  const root = asRecord(payload);
  if (root.object !== "page") return { messages, statuses };
  for (const entryValue of Array.isArray(root.entry) ? root.entry : []) {
    const entry = asRecord(entryValue);
    const entryPageId = String(entry.id ?? "").trim();
    for (const eventValue of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const event = asRecord(eventValue);
      const senderId = String(asRecord(event.sender).id ?? "").trim();
      const recipientId = String(asRecord(event.recipient).id ?? "").trim();
      const pageId = entryPageId || recipientId;
      const message = asRecord(event.message);
      const mid = String(message.mid ?? "").trim();
      if (mid && senderId && pageId && message.is_echo !== true && senderId !== pageId) {
        const attachment = attachmentContent(message);
        const text = typeof message.text === "string" ? message.text : "";
        const quickReply = asRecord(message.quick_reply);
        const replyTo = asRecord(message.reply_to);
        messages.push({
          eventId: `facebook:${pageId}:${mid}`,
          externalAccountId: pageId,
          externalConversationId: senderId,
          externalMessageId: mid,
          externalUserId: senderId,
          displayName: typeof event.sender_name === "string" ? event.sender_name : "Facebook Müşterisi",
          body: text || attachment?.body || "[Mesaj]",
          messageType: text ? "TEXT" : attachment?.messageType ?? "UNKNOWN",
          externalCreatedAt: providerTimestamp(event.timestamp, nowMs),
          metadata: {
            provider: "meta_facebook",
            psid: senderId,
            page_id: pageId,
            message_type: text ? "text" : attachment ? String(attachment.metadata.attachment_type) : "unknown",
            ...safeDefined({ quick_reply_payload: quickReply.payload, reply_to_mid: replyTo.mid }),
            ...(attachment?.metadata ?? {}),
          },
        });
      }

      const delivery = asRecord(event.delivery);
      for (const deliveredMid of Array.isArray(delivery.mids) ? delivery.mids : []) {
        const externalMessageId = String(deliveredMid ?? "").trim();
        if (!externalMessageId || !pageId) continue;
        statuses.push({
          eventId: `facebook-status:${pageId}:${externalMessageId}:delivered:${String(delivery.watermark ?? event.timestamp ?? "")}`,
          externalAccountId: pageId,
          externalMessageId,
          status: "DELIVERED",
          externalCreatedAt: providerTimestamp(delivery.watermark ?? event.timestamp, nowMs),
          metadata: { provider: "meta_facebook", provider_status: "delivered" },
        });
      }
      // Messenger's normal read event is watermark-based and has no message id.
      // It cannot safely drive the external-message-id status API, so no synthetic READ is emitted.
    }
  }
  return { messages, statuses };
}

export class FacebookMessengerAdapter implements ChannelAdapter {
  readonly channelType = "META_FACEBOOK" as const;
  readonly capabilities = capabilities;
  private readonly transport: MetaTransport;
  private readonly now: () => number;

  constructor(options: AdapterOptions) {
    this.transport = new MetaTransport(options);
    this.now = options.now ?? Date.now;
  }

  validateConfiguration(credentials: Record<string, string> | null, externalAccountId?: string) {
    const errors = ["access_token", "page_id", "graph_api_version"]
      .filter(key => !credentials?.[key]?.trim()).map(key => `${key} is required`);
    if (credentials?.graph_api_version && !/^v\d+\.\d+$/.test(credentials.graph_api_version.trim())) {
      errors.push("graph_api_version must use vXX.X format");
    }
    if (externalAccountId && credentials?.page_id?.trim() && credentials.page_id.trim() !== externalAccountId) {
      errors.push("page_id must match external_account_id");
    }
    return { valid: errors.length === 0, errors };
  }

  validateReply(envelope: OutboundEnvelope, context: ReplyValidationContext): void {
    const row = context.db.prepare(`SELECT COALESCE(external_created_at,received_at,created_at) last_inbound_at
      FROM messages WHERE channel_account_id=? AND conversation_id=(SELECT id FROM conversations WHERE channel_account_id=? AND external_conversation_id=?)
      AND direction='INBOUND' ORDER BY datetime(COALESCE(external_created_at,received_at,created_at)) DESC,rowid DESC LIMIT 1`)
      .get(context.id, context.id, envelope.externalConversationId) as { last_inbound_at: string } | undefined;
    const lastInbound = row ? Date.parse(row.last_inbound_at) : Number.NaN;
    if (!Number.isFinite(lastInbound) || this.now() - lastInbound > SERVICE_WINDOW_MS) {
      throw new ProviderError("Facebook 24-hour messaging window is closed", false, "FACEBOOK_MESSAGE_WINDOW_CLOSED");
    }
  }

  handleWebhook(payload: unknown) { return normalizeFacebookWebhook(payload, this.now()); }

  async sendMessage(envelope: OutboundEnvelope, account: ChannelAccountContext): Promise<SendResult> {
    const credentials = this.credentials(account);
    const response = await this.transport.post(GRAPH_ORIGIN, credentials.graph_api_version, credentials.page_id, "messages", credentials.access_token, {
      recipient: { id: envelope.externalConversationId },
      messaging_type: "RESPONSE",
      message: { text: envelope.body },
    });
    const id = String(response.message_id ?? "").trim();
    if (!id) throw new ProviderError("Facebook response is missing a message id", true, "PROVIDER_UNAVAILABLE");
    return { externalMessageId: id, status: "SENT" };
  }

  async markRead(externalUserId: string, account: ChannelAccountContext): Promise<void> {
    const credentials = this.credentials(account);
    await this.transport.post(GRAPH_ORIGIN, credentials.graph_api_version, credentials.page_id, "messages", credentials.access_token, {
      recipient: { id: externalUserId },
      sender_action: "mark_seen",
    });
  }

  private credentials(account: ChannelAccountContext): FacebookCredentials {
    const value = account.credentials;
    const validation = this.validateConfiguration(value, account.externalAccountId);
    if (!validation.valid || !value) {
      const mismatch = validation.errors.some(item => item.includes("external_account_id"));
      throw new ProviderError("Facebook account is not configured", false, mismatch ? "ACCOUNT_CONFIGURATION_MISMATCH" : "NOT_CONFIGURED");
    }
    return { access_token: value.access_token, page_id: value.page_id.trim(), graph_api_version: value.graph_api_version.trim() };
  }
}

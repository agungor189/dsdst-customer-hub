import type { Capability } from "../../../shared/contracts/domain.js";
import type { ChannelAccountContext, ChannelAdapter, OutboundEnvelope, SendResult } from "../core/types.js";

const capabilities: ReadonlySet<Capability> = new Set([
  "READ_MESSAGES",
  "SEND_MESSAGES",
  "WEBHOOK",
  "ATTACHMENTS",
]);

export type WebsiteCredentials = {
  site_id: string;
  site_name: string;
  allowed_origins: string[];
  widget_secret?: string;
};

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  let values: unknown;
  try { values = JSON.parse(value); } catch { values = value.split(",").map(item => item.trim()).filter(Boolean); }
  if (!Array.isArray(values) || values.some(item => typeof item !== "string")) return [];
  return [...new Set(values.map(item => item.trim()).filter(Boolean))];
}

function isExactOrigin(value: string): boolean {
  if (value.includes("*")) return false;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    return (url.protocol === "https:" || localHttp) && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}

export function parseWebsiteCredentials(credentials: Record<string, string> | null): WebsiteCredentials | null {
  if (!credentials) return null;
  const allowedOrigins = parseAllowedOrigins(credentials.allowed_origins);
  if (!credentials.site_id?.trim() || !credentials.site_name?.trim() || allowedOrigins.length === 0 || allowedOrigins.some(origin => !isExactOrigin(origin))) return null;
  return {
    site_id: credentials.site_id.trim(),
    site_name: credentials.site_name.trim(),
    allowed_origins: allowedOrigins,
    ...(credentials.widget_secret ? {widget_secret: credentials.widget_secret} : {}),
  };
}

export class WebsiteAdapter implements ChannelAdapter {
  readonly channelType = "WEBSITE" as const;
  readonly capabilities = capabilities;

  validateConfiguration(credentials: Record<string, string> | null, externalAccountId?: string) {
    const errors: string[] = [];
    const parsed = parseWebsiteCredentials(credentials);
    if (!credentials?.site_id?.trim()) errors.push("site_id is required");
    if (!credentials?.site_name?.trim()) errors.push("site_name is required");
    if (!credentials?.allowed_origins) errors.push("allowed_origins is required");
    else if (!parsed) errors.push("allowed_origins must contain exact HTTPS origins (localhost HTTP is allowed for development); wildcards are forbidden");
    if (credentials?.site_id && externalAccountId && credentials.site_id.trim() !== externalAccountId) errors.push("external_account_id must equal site_id");
    if (credentials?.widget_secret && credentials.widget_secret.length < 16) errors.push("widget_secret must be at least 16 characters when provided");
    return {valid: errors.length === 0, errors};
  }

  async sendMessage(envelope: OutboundEnvelope, _account: ChannelAccountContext): Promise<SendResult> {
    // First-party delivery is persisted in the Hub. The widget acknowledges delivery/read via the public API.
    return {externalMessageId: `website-${envelope.messageId}`, status: "SENT"};
  }
}

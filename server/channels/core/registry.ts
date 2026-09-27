import type { AppConfig } from "../../config.js";
import type { ChannelType, Capability } from "../../../shared/contracts/domain.js";
import type { ChannelAdapter } from "./types.js";
import { FoundationAdapter } from "./base.js";
import { TrendyolAdapter } from "../trendyol/adapter.js";
import { WhatsAppCloudAdapter } from "../whatsapp/adapter.js";
import { EmailAdapter } from "../email/adapter.js";
import { FacebookMessengerAdapter } from "../facebook/adapter.js";
import { InstagramMessagingAdapter } from "../instagram/adapter.js";
import { WebsiteAdapter } from "../website/adapter.js";

const caps = (...values: Capability[]) => new Set(values);

export function createAdapterRegistry(config: AppConfig) {
  const adapters: ChannelAdapter[] = [
    new InstagramMessagingAdapter({ timeoutMs: config.outboundTimeoutMs }),
    new FacebookMessengerAdapter({ timeoutMs: config.outboundTimeoutMs }),
    new WhatsAppCloudAdapter({ timeoutMs: config.outboundTimeoutMs }),
    new EmailAdapter({ timeoutMs: config.outboundTimeoutMs, attachmentsDir: config.attachmentsDir }),
    new WebsiteAdapter(),
    new TrendyolAdapter({ timeoutMs: config.outboundTimeoutMs }),
    new FoundationAdapter("N11", caps(), [], false),
    new FoundationAdapter("MANUAL_EXTERNAL", caps("READ_MESSAGES","CUSTOMER_PROFILE")),
  ];
  const byType = new Map(adapters.map(adapter => [adapter.channelType, adapter]));
  return {
    get(type: ChannelType) { const adapter = byType.get(type); if (!adapter) throw new Error(`Adapter not registered: ${type}`); return adapter; },
    list() { return adapters.map(a => ({ channelType: a.channelType, capabilities: [...a.capabilities] })); },
  };
}
export type AdapterRegistry = ReturnType<typeof createAdapterRegistry>;

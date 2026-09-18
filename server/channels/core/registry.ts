import type { AppConfig } from "../../config.js";
import type { ChannelType, Capability } from "../../../shared/contracts/domain.js";
import type { ChannelAdapter } from "./types.js";
import { DevelopmentMockAdapter, FoundationAdapter } from "./base.js";

const caps = (...values: Capability[]) => new Set(values);

export function createAdapterRegistry(config: AppConfig) {
  const adapters: ChannelAdapter[] = [
    new FoundationAdapter("META_INSTAGRAM", caps("READ_MESSAGES","SEND_MESSAGES","WEBHOOK","ATTACHMENTS","MARK_READ","CUSTOMER_PROFILE"), ["access_token","account_id"]),
    new FoundationAdapter("META_FACEBOOK", caps("READ_MESSAGES","SEND_MESSAGES","WEBHOOK","ATTACHMENTS","MARK_READ","CUSTOMER_PROFILE"), ["access_token","page_id"]),
    new FoundationAdapter("META_WHATSAPP", caps("READ_MESSAGES","SEND_MESSAGES","WEBHOOK","ATTACHMENTS","MARK_READ","CUSTOMER_PROFILE"), ["access_token","phone_number_id"]),
    new FoundationAdapter("EMAIL", caps("READ_MESSAGES","SEND_MESSAGES","POLLING","ATTACHMENTS","CUSTOMER_PROFILE"), ["imap_host","smtp_host","username","password"]),
    config.mockAdaptersEnabled ? new DevelopmentMockAdapter("WEBSITE", caps("READ_MESSAGES","SEND_MESSAGES","WEBHOOK","ATTACHMENTS")) : new FoundationAdapter("WEBSITE", caps("READ_MESSAGES","SEND_MESSAGES","WEBHOOK","ATTACHMENTS"), ["webhook_secret","send_endpoint"]),
    new FoundationAdapter("TRENDYOL", caps("READ_MESSAGES","SEND_MESSAGES","POLLING","PRODUCT_QUESTIONS"), ["seller_id","api_key","api_secret"]),
    new FoundationAdapter("N11", caps("READ_MESSAGES","SEND_MESSAGES","POLLING","PRODUCT_QUESTIONS"), ["api_key","api_secret"]),
    new FoundationAdapter("MANUAL_EXTERNAL", caps("READ_MESSAGES","CUSTOMER_PROFILE")),
  ];
  const byType = new Map(adapters.map(adapter => [adapter.channelType, adapter]));
  return {
    get(type: ChannelType) { const adapter = byType.get(type); if (!adapter) throw new Error(`Adapter not registered: ${type}`); return adapter; },
    list() { return adapters.map(a => ({ channelType: a.channelType, capabilities: [...a.capabilities] })); },
  };
}
export type AdapterRegistry = ReturnType<typeof createAdapterRegistry>;

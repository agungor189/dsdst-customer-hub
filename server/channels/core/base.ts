import type { Capability, ChannelType } from "../../../shared/contracts/domain.js";
import type { ChannelAdapter, OutboundEnvelope, SendResult } from "./types.js";
import { ProviderError } from "./types.js";

export class FoundationAdapter implements ChannelAdapter {
  constructor(public readonly channelType: ChannelType, public readonly capabilities: ReadonlySet<Capability>, private readonly required: string[] = []) {}
  validateConfiguration(credentials: Record<string,string> | null) {
    const errors = this.required.filter(key => !credentials?.[key]).map(key => `${key} is required`);
    return { valid: errors.length === 0, errors };
  }
  async sendMessage(_envelope: OutboundEnvelope, credentials: Record<string,string> | null): Promise<SendResult> {
    const validation = this.validateConfiguration(credentials);
    if (!this.capabilities.has("SEND_MESSAGES")) throw new ProviderError(`${this.channelType} direct reply desteklemiyor`, false, "CAPABILITY_UNSUPPORTED");
    if (!validation.valid) throw new ProviderError(`${this.channelType} yapılandırılmamış`, false, "NOT_CONFIGURED");
    throw new ProviderError(`${this.channelType} provider implementation henüz yapılandırılmadı`, false, "NOT_CONFIGURED");
  }
}

export class DevelopmentMockAdapter extends FoundationAdapter {
  private sent = new Map<string, SendResult>();
  override validateConfiguration() { return { valid: true, errors: [] }; }
  override async sendMessage(envelope: OutboundEnvelope): Promise<SendResult> {
    const existing = this.sent.get(envelope.messageId); if (existing) return existing;
    if (envelope.body.includes("[fail-retry]")) throw new ProviderError("Mock transient outage", true, "PROVIDER_UNAVAILABLE");
    const result: SendResult = { externalMessageId: `mock-${envelope.messageId}`, status: "SENT" };
    this.sent.set(envelope.messageId, result); return result;
  }
}

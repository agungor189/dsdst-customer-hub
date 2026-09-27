import { ProviderError } from "../core/types.js";

type MetaTransportOptions = {
  timeoutMs: number;
  fetch?: typeof fetch;
};

export class MetaTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MetaTransportOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async post(origin: string, version: string, accountId: string, path: string, accessToken: string, body: Record<string, unknown>) {
    try {
      const response = await this.fetchImpl(
        `${origin}/${version}/${encodeURIComponent(accountId)}/${path}`,
        {
          method: "POST",
          signal: AbortSignal.timeout(this.options.timeoutMs),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw mapMetaHttpError(response.status);
      const raw = await response.text();
      if (!raw) return {};
      const value: unknown = JSON.parse(raw);
      return value && typeof value === "object" ? value as Record<string, unknown> : {};
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Meta provider is unavailable", true, "PROVIDER_UNAVAILABLE");
    }
  }
}

export function mapMetaHttpError(status: number): ProviderError {
  if (status === 400) return new ProviderError("Meta rejected the request", false, "PROVIDER_VALIDATION_FAILED");
  if (status === 401) return new ProviderError("Meta authentication failed", false, "AUTHENTICATION_FAILED");
  if (status === 403) return new ProviderError("Meta authorization failed", false, "AUTHORIZATION_FAILED");
  if (status === 404) return new ProviderError("Meta resource was not found", false, "RESOURCE_NOT_FOUND");
  if (status === 429) return new ProviderError("Meta rate limit exceeded", true, "RATE_LIMITED");
  if (status >= 500) return new ProviderError("Meta provider is unavailable", true, "PROVIDER_UNAVAILABLE");
  return new ProviderError("Meta rejected the request", false, "PROVIDER_VALIDATION_FAILED");
}

export function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

export function providerTimestamp(value: unknown, fallbackMs: number): string {
  const numeric = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return new Date(fallbackMs).toISOString();
  return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString();
}

export function safeDefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

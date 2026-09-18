import path from "node:path";

const int = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} geçerli pozitif sayı olmalı`);
  return value;
};

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const production = process.env.NODE_ENV === "production";
  const key = process.env.CUSTOMER_HUB_ENCRYPTION_KEY ?? (production ? "" : "0".repeat(64));
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("CUSTOMER_HUB_ENCRYPTION_KEY 32-byte hex anahtar olmalı");
  return {
    production,
    port: int("PORT", 3100),
    appOrigin: process.env.APP_ORIGIN ?? "http://localhost:3100",
    panelBaseUrl: (process.env.PANEL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    databasePath: path.resolve(process.env.DATABASE_PATH ?? "./data/customer-hub.db"),
    attachmentsDir: path.resolve(process.env.ATTACHMENTS_DIR ?? "./data/attachments"),
    encryptionKey: Buffer.from(key, "hex"),
    sessionCookieName: process.env.SESSION_COOKIE_NAME ?? "dsdst_customer_hub_session",
    sessionSecure: process.env.SESSION_SECURE ? process.env.SESSION_SECURE === "true" : production,
    panelTimeoutMs: int("PANEL_REQUEST_TIMEOUT_MS", 5000),
    outboxPollMs: int("OUTBOX_POLL_INTERVAL_MS", 1000),
    outboundTimeoutMs: int("OUTBOUND_REQUEST_TIMEOUT_MS", 10_000),
    webhookMaxAgeSeconds: int("WEBHOOK_MAX_AGE_SECONDS", 300),
    metaAppSecret: process.env.META_APP_SECRET ?? "",
    metaVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? "",
    mockAdaptersEnabled: process.env.MOCK_ADAPTERS_ENABLED === "true" && !production,
    allowedRemoteAttachmentHosts: (process.env.ALLOWED_REMOTE_ATTACHMENT_HOSTS ?? "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean),
    version: process.env.APP_VERSION ?? "0.1.0",
    commit: process.env.APP_COMMIT ?? "dev",
  };
}

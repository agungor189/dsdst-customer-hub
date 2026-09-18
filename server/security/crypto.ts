import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function encryptSecret(value: unknown, key: Buffer): string {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret<T>(value: string, key: Buffer): T {
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid encrypted credential envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8")) as T;
}

const sensitiveKey = /token|secret|password|authorization|credential|cookie|api[-_]?key/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : redact(child)]));
  return value;
}

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { InstagramMessagingAdapter, normalizeInstagramWebhook } from "./adapter.js";
import { ProviderError, type ChannelAdapter } from "../core/types.js";
import type { AdapterRegistry } from "../core/registry.js";
import { testDatabase } from "../../test-utils.js";
import { ingestInbound } from "../../messages/inbound.js";
import { queueReply } from "../../outbox/service.js";

const credentials = { access_token: "instagram-secret-token", ig_account_id: "ig-1", graph_api_version: "v23.0" };
const account = { id: "instagram-account", externalAccountId: "ig-1", credentials };
const envelope = { messageId: "hub-1", externalConversationId: "igsid-1", body: "Merhaba!", metadata: {} };
const admin = { id: "admin", username: "Admin", role: "admin" as const, permissions: {} };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function expectProvider(code: string, retryable: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    return true;
  };
}

function payload(message: Record<string, unknown> = { mid: "ig-in-1", text: "Ürün stokta mı?" }, input: { account?: string; sender?: string; timestamp?: number } = {}) {
  const accountId = input.account ?? "ig-1";
  return { object: "instagram", entry: [{ id: accountId, messaging: [{ sender: { id: input.sender ?? "igsid-1" }, recipient: { id: accountId }, timestamp: input.timestamp ?? 1_700_000_000_000, message }] }] };
}

function installAccount(db: Database.Database, accountId = "ig-1") {
  const seeded = db.prepare("SELECT id FROM channel_accounts WHERE channel_type='META_INSTAGRAM' AND external_account_id='demo-instagram'").get() as { id: string } | undefined;
  if (seeded) {
    db.prepare("DELETE FROM messages WHERE channel_account_id=?").run(seeded.id);
    db.prepare("DELETE FROM conversations WHERE channel_account_id=?").run(seeded.id);
    db.prepare("DELETE FROM contact_identities WHERE channel_account_id=?").run(seeded.id);
    db.prepare("UPDATE channel_accounts SET external_account_id=?,status='ACTIVE' WHERE id=?").run(accountId, seeded.id);
    return seeded.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,external_account_id) VALUES(?,'META_INSTAGRAM','Instagram','ACTIVE',?)").run(id, accountId);
  return id;
}

function registryFor(adapter: ChannelAdapter): AdapterRegistry {
  return { get: () => adapter, list: () => [] } as unknown as AdapterRegistry;
}

test("Instagram credential schema validates required fields, version and account ownership", () => {
  const adapter = new InstagramMessagingAdapter({ timeoutMs: 100, fetch: async () => response({}) });
  assert.deepEqual(adapter.validateConfiguration(credentials, "ig-1"), { valid: true, errors: [] });
  assert.match(adapter.validateConfiguration({ access_token: "x", ig_account_id: "ig" }).errors.join(" "), /graph_api_version is required/);
  assert.match(adapter.validateConfiguration({ ...credentials, graph_api_version: "23.0" }).errors.join(" "), /vXX\.X/);
  assert.match(adapter.validateConfiguration(credentials, "other").errors.join(" "), /external_account_id/);
});

test("Instagram accepts legacy account_id as the ig_account_id alias", async () => {
  let url = "";
  const adapter = new InstagramMessagingAdapter({ timeoutMs: 100, fetch: async (input) => { url = String(input); return response({ message_id: "ig-out-1" }); } });
  const legacy = { access_token: "x", account_id: "ig-legacy", graph_api_version: "v22.0" };
  assert.deepEqual(adapter.validateConfiguration(legacy, "ig-legacy"), { valid: true, errors: [] });
  await adapter.sendMessage(envelope, { id: "legacy", externalAccountId: "ig-legacy", credentials: legacy });
  assert.equal(url, "https://graph.instagram.com/v22.0/ig-legacy/messages");
});

test("Instagram outbound text uses Instagram Graph endpoint, Bearer auth and provider message id", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const adapter = new InstagramMessagingAdapter({ timeoutMs: 100, fetch: async (input, init) => { captured = { url: String(input), init }; return response({ message_id: "ig-out-1" }); } });
  assert.deepEqual(await adapter.sendMessage(envelope, account), { externalMessageId: "ig-out-1", status: "SENT" });
  assert.equal(captured!.url, "https://graph.instagram.com/v23.0/ig-1/messages");
  assert.equal(new Headers(captured!.init?.headers).get("authorization"), "Bearer instagram-secret-token");
  assert.deepEqual(JSON.parse(String(captured!.init?.body)), { recipient: { id: "igsid-1" }, message: { text: "Merhaba!" } });
});

for (const [status, code, retryable] of [[400, "PROVIDER_VALIDATION_FAILED", false], [401, "AUTHENTICATION_FAILED", false], [403, "AUTHORIZATION_FAILED", false], [404, "RESOURCE_NOT_FOUND", false], [429, "RATE_LIMITED", true], [500, "PROVIDER_UNAVAILABLE", true]] as const) {
  test(`Instagram HTTP ${status} maps to ${code}`, async () => {
    const adapter = new InstagramMessagingAdapter({ timeoutMs: 100, fetch: async () => response({}, status) });
    await assert.rejects(() => adapter.sendMessage(envelope, account), expectProvider(code, retryable));
  });
}

test("Instagram network failures are retryable and redact provider credential values", async () => {
  const adapter = new InstagramMessagingAdapter({ timeoutMs: 100, fetch: async () => { throw new Error(credentials.access_token); } });
  await assert.rejects(() => adapter.sendMessage(envelope, account), error => {
    expectProvider("PROVIDER_UNAVAILABLE", true)(error);
    assert.doesNotMatch((error as Error).message, /instagram-secret-token/);
    return true;
  });
});

test("Instagram inbound text normalizes scoped identity and fallback display name", () => {
  assert.deepEqual(normalizeInstagramWebhook(payload()).messages[0], {
    eventId: "instagram:ig-1:ig-in-1", externalAccountId: "ig-1", externalConversationId: "igsid-1", externalMessageId: "ig-in-1",
    externalUserId: "igsid-1", displayName: "Instagram Müşterisi", body: "Ürün stokta mı?", messageType: "TEXT", externalCreatedAt: "2023-11-14T22:13:20.000Z",
    metadata: { provider: "meta_instagram", instagram_scoped_id: "igsid-1", ig_account_id: "ig-1", message_type: "text" },
  });
});

test("Instagram self/echo messages are ignored", () => {
  assert.equal(normalizeInstagramWebhook(payload({ mid: "echo", text: "ours", is_echo: true })).messages.length, 0);
  assert.equal(normalizeInstagramWebhook(payload({ mid: "self", text: "ours" }, { sender: "ig-1" })).messages.length, 0);
});

test("Instagram image and share messages remain visible as placeholders with safe metadata", () => {
  const image = normalizeInstagramWebhook(payload({ mid: "image", attachments: [{ type: "image", payload: { id: "asset-1", url: "https://cdn.example.test/image.jpg" } }] })).messages[0];
  assert.equal(image.body, "[Görsel]"); assert.equal(image.messageType, "IMAGE"); assert.equal(image.metadata.provider_attachment_id, "asset-1");
  const share = normalizeInstagramWebhook(payload({ mid: "share", shares: [{ id: "share-1", link: "https://instagram.com/p/1", title: "Post" }] })).messages[0];
  assert.equal(share.body, "[Paylaşım]"); assert.equal(share.messageType, "SHARE"); assert.equal(share.metadata.attachment_url, "https://instagram.com/p/1");
});

test("Instagram duplicate mids are idempotent and scoped per account", () => {
  const { db } = testDatabase();
  installAccount(db, "ig-1");
  const secondId = randomUUID();
  db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,external_account_id) VALUES(?,'META_INSTAGRAM','Instagram 2','ACTIVE','ig-2')").run(secondId);
  const first = normalizeInstagramWebhook(payload({ mid: "same", text: "one" }, { account: "ig-1" })).messages[0];
  const second = normalizeInstagramWebhook(payload({ mid: "same", text: "two" }, { account: "ig-2" })).messages[0];
  assert.equal(ingestInbound(db, "META_INSTAGRAM", first).duplicate, false);
  assert.equal(ingestInbound(db, "META_INSTAGRAM", first).duplicate, true);
  assert.equal(ingestInbound(db, "META_INSTAGRAM", second).duplicate, false);
  assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE external_message_id='same'").get() as any).count, 2);
  db.close();
});

test("Instagram outbound is blocked unless that customer initiated an inbound conversation", () => {
  const { db } = testDatabase();
  const accountId = installAccount(db);
  const adapter = new InstagramMessagingAdapter({ timeoutMs: 100, fetch: async () => response({ message_id: "x" }) });
  const contactId = randomUUID(); const conversationId = randomUUID();
  db.prepare("INSERT INTO contacts(id,display_name) VALUES(?,'Müşteri')").run(contactId);
  db.prepare("INSERT INTO conversations(id,channel_account_id,contact_id,external_conversation_id) VALUES(?,?,?,'igsid-not-started')").run(conversationId, accountId, contactId);
  assert.throws(() => queueReply(db, registryFor(adapter), conversationId, "Unsolicited", randomUUID(), admin), expectProvider("INSTAGRAM_CONVERSATION_NOT_STARTED", false));
  assert.equal((db.prepare("SELECT count(*) count FROM outbox_jobs").get() as any).count, 0);
  db.close();
});

test("Instagram outbound is allowed for the exact account-scoped inbound identity", () => {
  const { db } = testDatabase();
  installAccount(db);
  const adapter = new InstagramMessagingAdapter({ timeoutMs: 100, fetch: async () => response({ message_id: "x" }) });
  const inbound = ingestInbound(db, "META_INSTAGRAM", normalizeInstagramWebhook(payload()).messages[0]);
  assert.doesNotThrow(() => queueReply(db, registryFor(adapter), inbound.conversationId!, "Yanıt", randomUUID(), admin));
  db.close();
});

test("Instagram does not claim unsupported MARK_READ capability", () => {
  const adapter = new InstagramMessagingAdapter({ timeoutMs: 100, fetch: async () => response({}) });
  assert.equal(adapter.capabilities.has("MARK_READ"), false);
  assert.equal(adapter.capabilities.has("CUSTOMER_PROFILE"), true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { FacebookMessengerAdapter, normalizeFacebookWebhook } from "./adapter.js";
import { ProviderError, type ChannelAdapter } from "../core/types.js";
import type { AdapterRegistry } from "../core/registry.js";
import { testDatabase } from "../../test-utils.js";
import { ingestInbound } from "../../messages/inbound.js";
import { applyMessageStatus } from "../../messages/status.js";
import { queueReply } from "../../outbox/service.js";
import { OutboxWorker } from "../../outbox/worker.js";
import { encryptSecret } from "../../security/crypto.js";

const credentials = { access_token: "facebook-secret-token", page_id: "page-1", graph_api_version: "v23.0" };
const account = { id: "facebook-account", externalAccountId: "page-1", credentials };
const envelope = { messageId: "hub-1", externalConversationId: "psid-1", body: "Merhaba!", metadata: {} };
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

function payload(message: Record<string, unknown> = { mid: "fb-in-1", text: "Siparişim nerede?" }, input: { page?: string; sender?: string; timestamp?: number } = {}) {
  const page = input.page ?? "page-1";
  return { object: "page", entry: [{ id: page, messaging: [{ sender: { id: input.sender ?? "psid-1" }, recipient: { id: page }, timestamp: input.timestamp ?? 1_700_000_000_000, message }] }] };
}

function installAccount(db: Database.Database, page = "page-1") {
  const id = randomUUID();
  db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,external_account_id) VALUES(?,'META_FACEBOOK','Facebook','ACTIVE',?)").run(id, page);
  return id;
}

function registryFor(adapter: ChannelAdapter): AdapterRegistry {
  return { get: () => adapter, list: () => [] } as unknown as AdapterRegistry;
}

test("Facebook credential schema validates required fields, Graph version and page ownership", () => {
  const adapter = new FacebookMessengerAdapter({ timeoutMs: 100, fetch: async () => response({}) });
  assert.deepEqual(adapter.validateConfiguration(credentials, "page-1"), { valid: true, errors: [] });
  assert.match(adapter.validateConfiguration({ access_token: "x", page_id: "p" }).errors.join(" "), /graph_api_version is required/);
  assert.match(adapter.validateConfiguration({ ...credentials, graph_api_version: "23.0" }).errors.join(" "), /vXX\.X/);
  assert.match(adapter.validateConfiguration(credentials, "other").errors.join(" "), /external_account_id/);
});

test("Facebook outbound text uses page endpoint, Bearer auth, RESPONSE body and provider message id", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const adapter = new FacebookMessengerAdapter({ timeoutMs: 100, fetch: async (input, init) => { captured = { url: String(input), init }; return response({ message_id: "fb-out-1" }); } });
  assert.deepEqual(await adapter.sendMessage(envelope, account), { externalMessageId: "fb-out-1", status: "SENT" });
  assert.equal(captured!.url, "https://graph.facebook.com/v23.0/page-1/messages");
  assert.equal(new Headers(captured!.init?.headers).get("authorization"), "Bearer facebook-secret-token");
  assert.deepEqual(JSON.parse(String(captured!.init?.body)), { recipient: { id: "psid-1" }, messaging_type: "RESPONSE", message: { text: "Merhaba!" } });
});

test("Facebook markRead sends mark_seen to the account-scoped endpoint", async () => {
  let captured: { url: string; body: unknown } | undefined;
  const adapter = new FacebookMessengerAdapter({ timeoutMs: 100, fetch: async (input, init) => { captured = { url: String(input), body: JSON.parse(String(init?.body)) }; return response({ recipient_id: "psid-1" }); } });
  await adapter.markRead("psid-1", account);
  assert.equal(captured!.url, "https://graph.facebook.com/v23.0/page-1/messages");
  assert.deepEqual(captured!.body, { recipient: { id: "psid-1" }, sender_action: "mark_seen" });
});

for (const [status, code, retryable] of [[400, "PROVIDER_VALIDATION_FAILED", false], [401, "AUTHENTICATION_FAILED", false], [403, "AUTHORIZATION_FAILED", false], [404, "RESOURCE_NOT_FOUND", false], [429, "RATE_LIMITED", true], [500, "PROVIDER_UNAVAILABLE", true]] as const) {
  test(`Facebook HTTP ${status} maps to ${code}`, async () => {
    const adapter = new FacebookMessengerAdapter({ timeoutMs: 100, fetch: async () => response({}, status) });
    await assert.rejects(() => adapter.sendMessage(envelope, account), expectProvider(code, retryable));
  });
}

test("Facebook network failures are retryable and do not expose credential values", async () => {
  const adapter = new FacebookMessengerAdapter({ timeoutMs: 100, fetch: async () => { throw new Error(credentials.access_token); } });
  await assert.rejects(() => adapter.sendMessage(envelope, account), error => {
    expectProvider("PROVIDER_UNAVAILABLE", true)(error);
    assert.doesNotMatch((error as Error).message, /facebook-secret-token/);
    return true;
  });
});

test("Facebook inbound text normalizes identity, timestamp and safe metadata", () => {
  assert.deepEqual(normalizeFacebookWebhook(payload()).messages[0], {
    eventId: "facebook:page-1:fb-in-1", externalAccountId: "page-1", externalConversationId: "psid-1", externalMessageId: "fb-in-1",
    externalUserId: "psid-1", displayName: "Facebook Müşterisi", body: "Siparişim nerede?", messageType: "TEXT", externalCreatedAt: "2023-11-14T22:13:20.000Z",
    metadata: { provider: "meta_facebook", psid: "psid-1", page_id: "page-1", message_type: "text" },
  });
});

test("Facebook echo is ignored and inbound attachment survives as a placeholder", () => {
  assert.equal(normalizeFacebookWebhook(payload({ mid: "echo", text: "ours", is_echo: true })).messages.length, 0);
  const image = normalizeFacebookWebhook(payload({ mid: "image-1", attachments: [{ type: "image", payload: { url: "https://cdn.example.test/a.jpg", id: "asset-1" } }] })).messages[0];
  assert.equal(image.body, "[Görsel]");
  assert.equal(image.messageType, "IMAGE");
  assert.equal(image.metadata.provider_attachment_id, "asset-1");
  assert.equal(image.metadata.attachment_url, "https://cdn.example.test/a.jpg");
});

test("Facebook delivery events use generic status normalization without manufacturing watermark reads", () => {
  const batch = normalizeFacebookWebhook({ object: "page", entry: [{ id: "page-1", messaging: [
    { sender: { id: "psid-1" }, recipient: { id: "page-1" }, delivery: { mids: ["fb-out-1"], watermark: 1_700_000_100_000 } },
    { sender: { id: "psid-1" }, recipient: { id: "page-1" }, read: { watermark: 1_700_000_200_000 } },
  ] }] });
  assert.equal(batch.statuses.length, 1);
  assert.equal(batch.statuses[0].status, "DELIVERED");
  assert.equal(batch.statuses[0].externalMessageId, "fb-out-1");
});

test("Facebook duplicate mids are idempotent and accounts remain isolated", () => {
  const { db } = testDatabase();
  installAccount(db, "page-1"); installAccount(db, "page-2");
  const first = normalizeFacebookWebhook(payload({ mid: "same", text: "one" }, { page: "page-1" })).messages[0];
  const second = normalizeFacebookWebhook(payload({ mid: "same", text: "two" }, { page: "page-2" })).messages[0];
  assert.equal(ingestInbound(db, "META_FACEBOOK", first).duplicate, false);
  assert.equal(ingestInbound(db, "META_FACEBOOK", first).duplicate, true);
  assert.equal(ingestInbound(db, "META_FACEBOOK", second).duplicate, false);
  assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE external_message_id='same'").get() as any).count, 2);
  db.close();
});

test("Facebook delivery status advances an outbound message and cannot downgrade it", () => {
  const { db } = testDatabase();
  const accountId = installAccount(db);
  const inbound = ingestInbound(db, "META_FACEBOOK", normalizeFacebookWebhook(payload()).messages[0]);
  const outboundId = randomUUID();
  db.prepare("INSERT INTO messages(id,conversation_id,channel_account_id,external_message_id,direction,sender_type,body_text,status) VALUES(?,?,?,'fb-out-1','OUTBOUND','AGENT','Yanıt','SENT')").run(outboundId, inbound.conversationId, accountId);
  const status = normalizeFacebookWebhook({ object: "page", entry: [{ id: "page-1", messaging: [{ sender: { id: "psid-1" }, recipient: { id: "page-1" }, delivery: { mids: ["fb-out-1"], watermark: 1_700_000_100_000 } }] }] }).statuses[0];
  applyMessageStatus(db, "META_FACEBOOK", status);
  applyMessageStatus(db, "META_FACEBOOK", status);
  assert.equal((db.prepare("SELECT status FROM messages WHERE id=?").get(outboundId) as any).status, "DELIVERED");
  db.close();
});

test("Facebook 24-hour window is enforced while queueing", () => {
  const { db } = testDatabase();
  const accountId = installAccount(db);
  const now = 1_800_000_000_000;
  const adapter = new FacebookMessengerAdapter({ timeoutMs: 100, now: () => now, fetch: async () => response({ message_id: "x" }) });
  const inbound = normalizeFacebookWebhook(payload({ mid: "recent", text: "hello" }, { timestamp: now - 60_000 }), now).messages[0];
  const ingested = ingestInbound(db, "META_FACEBOOK", inbound);
  assert.doesNotThrow(() => queueReply(db, registryFor(adapter), ingested.conversationId!, "Yanıt", randomUUID(), admin));
  db.prepare("UPDATE messages SET external_created_at=? WHERE channel_account_id=? AND direction='INBOUND'").run(new Date(now - 24 * 60 * 60 * 1000 - 1).toISOString(), accountId);
  assert.throws(() => queueReply(db, registryFor(adapter), ingested.conversationId!, "Geç", randomUUID(), admin), expectProvider("FACEBOOK_MESSAGE_WINDOW_CLOSED", false));
  db.close();
});

test("Facebook worker rechecks a window that closes after queue and never calls provider", async () => {
  const { db, config } = testDatabase();
  const accountId = installAccount(db);
  let now = 1_800_000_000_000; let calls = 0;
  const adapter = new FacebookMessengerAdapter({ timeoutMs: 100, now: () => now, fetch: async () => { calls += 1; return response({ message_id: "nope" }); } });
  const inbound = ingestInbound(db, "META_FACEBOOK", normalizeFacebookWebhook(payload({ mid: "recent", text: "hello" }, { timestamp: now - 60_000 }), now).messages[0]);
  db.prepare("UPDATE channel_accounts SET encrypted_credentials=? WHERE id=?").run(encryptSecret(credentials, config.encryptionKey), accountId);
  const queued = queueReply(db, registryFor(adapter), inbound.conversationId!, "Yanıt", randomUUID(), admin);
  now += 24 * 60 * 60 * 1000 + 1;
  await new OutboxWorker(db, registryFor(adapter), config, "facebook-window-worker").tick();
  assert.equal(calls, 0);
  assert.equal((db.prepare("SELECT status FROM messages WHERE id=?").get(queued.id) as any).status, "FAILED");
  const job = db.prepare("SELECT status,last_error FROM outbox_jobs WHERE message_id=?").get(queued.id) as any;
  assert.equal(job.status, "FAILED");
  assert.match(job.last_error, /FACEBOOK_MESSAGE_WINDOW_CLOSED/);
  assert.doesNotMatch(job.last_error, /facebook-secret-token/);
  db.close();
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { testDatabase } from "../test-utils.js";
import { createAdapterRegistry } from "../channels/core/registry.js";
import { OutboxWorker } from "../outbox/worker.js";
import { createApp } from "../app.js";

const admin = { id: "admin", username: "Admin", role: "admin" as const, permissions: {} };

async function signedPost(base: string, secret: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return fetch(`${base}/api/webhooks/meta`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
}

test("shared Meta webhook routes page and instagram payloads only to their provider accounts", async () => {
  const { db, config } = testDatabase();
  const instagram = db.prepare("SELECT id FROM channel_accounts WHERE channel_type='META_INSTAGRAM' LIMIT 1").get() as { id: string };
  db.prepare("UPDATE channel_accounts SET external_account_id='ig-route-1' WHERE id=?").run(instagram.id);
  const facebookId = randomUUID();
  db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,external_account_id) VALUES(?,'META_FACEBOOK','Facebook','ACTIVE','page-route-1')").run(facebookId);
  const registry = createAdapterRegistry(config);
  const worker = new OutboxWorker(db, registry, config);
  const server = createApp({ db, config, registry, worker, verify: async () => admin }).listen(0);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("server");
  const base = `http://127.0.0.1:${address.port}`;

  const facebook = { object: "page", access_token: "must-not-persist", entry: [{ id: "page-route-1", messaging: [{ sender: { id: "psid-route" }, recipient: { id: "page-route-1" }, timestamp: 1_700_000_000_000, message: { mid: "fb-route-message", text: "Facebook" } }] }] };
  const instagramPayload = { object: "instagram", client_secret: "must-not-persist", entry: [{ id: "ig-route-1", messaging: [{ sender: { id: "igsid-route" }, recipient: { id: "ig-route-1" }, timestamp: 1_700_000_000_000, message: { mid: "ig-route-message", text: "Instagram" } }] }] };
  for (const payload of [facebook, facebook, instagramPayload, instagramPayload]) {
    const result = await signedPost(base, config.metaAppSecret, payload);
    assert.equal(result.status, 200);
  }

  const rows = db.prepare("SELECT a.channel_type,m.external_message_id,m.metadata_json FROM messages m JOIN channel_accounts a ON a.id=m.channel_account_id WHERE m.external_message_id IN ('fb-route-message','ig-route-message') ORDER BY m.external_message_id").all() as any[];
  assert.deepEqual(rows.map(row => [row.channel_type, row.external_message_id]), [["META_FACEBOOK", "fb-route-message"], ["META_INSTAGRAM", "ig-route-message"]]);
  assert.equal(rows.every(row => !row.metadata_json.includes("must-not-persist")), true);
  const webhookPayloads = db.prepare("SELECT payload_json FROM webhook_events WHERE external_event_id LIKE '%route-message%'").all() as Array<{ payload_json: string }>;
  assert.equal(webhookPayloads.every(row => !row.payload_json.includes("must-not-persist")), true);

  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close();
});

test("shared Meta webhook keeps verify challenge and rejects an invalid signature", async () => {
  const { db, config } = testDatabase();
  const registry = createAdapterRegistry(config); const worker = new OutboxWorker(db, registry, config);
  const server = createApp({ db, config, registry, worker, verify: async () => admin }).listen(0);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("server");
  const base = `http://127.0.0.1:${address.port}`;
  const challenge = await fetch(`${base}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=ok`);
  assert.equal(challenge.status, 200); assert.equal(await challenge.text(), "ok");
  const mismatch = await fetch(`${base}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=no`);
  assert.equal(mismatch.status, 403);
  const invalid = await fetch(`${base}/api/webhooks/meta`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=bad" }, body: JSON.stringify({ object: "page", entry: [] }) });
  assert.equal(invalid.status, 401);
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close();
});

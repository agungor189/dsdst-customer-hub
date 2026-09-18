import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { ingestInbound } from "../messages/inbound.js";

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function createMetaWebhookRouter(db: Database.Database, config: AppConfig) {
  const router = express.Router();
  router.get("/", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.metaVerifyToken) return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
    return res.status(403).end();
  });
  router.post("/", (req, res) => {
    if (!config.metaAppSecret) return res.status(503).json({ error: { code: "NOT_CONFIGURED" } });
    const signature = String(req.headers["x-hub-signature-256"] ?? "");
    const raw = (req as any).rawBody as Buffer | undefined;
    const expected = `sha256=${createHmac("sha256", config.metaAppSecret).update(raw ?? Buffer.alloc(0)).digest("hex")}`;
    if (!safeEqual(signature, expected)) return res.status(401).json({ error: { code: "INVALID_SIGNATURE" } });
    try {
      let accepted = 0;
      for (const entry of req.body?.entry ?? []) {
        for (const event of entry.messaging ?? entry.changes ?? []) {
          const value = event.value ?? event; const message = value.message ?? value.messages?.[0];
          if (!message) continue;
          const channel = value.messaging_product === "whatsapp" ? "META_WHATSAPP" : req.body.object === "instagram" ? "META_INSTAGRAM" : "META_FACEBOOK";
          ingestInbound(db, channel, {
            eventId: String(message.id ?? event.id), externalAccountId: String(value.metadata?.phone_number_id ?? entry.id),
            externalConversationId: String(value.contacts?.[0]?.wa_id ?? event.sender?.id ?? message.from), externalMessageId: String(message.id),
            externalUserId: String(message.from ?? event.sender?.id), displayName: String(value.contacts?.[0]?.profile?.name ?? event.sender?.id ?? "Meta müşteri"),
            body: String(message.text?.body ?? message.text ?? ""), messageType: String(message.type ?? "TEXT").toUpperCase(),
            externalCreatedAt: new Date(Number(message.timestamp ?? Date.now() / 1000) * 1000).toISOString(), metadata: { provider: "meta" },
          });
          accepted += 1;
        }
      }
      return res.status(200).json({ accepted });
    } catch (error: any) {
      return res.status(422).json({ error: { code: "WEBHOOK_PROCESSING_FAILED", message: error.message } });
    }
  });
  return router;
}

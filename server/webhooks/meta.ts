import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { ingestInbound } from "../messages/inbound.js";
import { applyMessageStatus } from "../messages/status.js";
import type { AdapterRegistry } from "../channels/core/registry.js";
import type { ChannelType } from "../../shared/contracts/domain.js";
import type { NormalizedWebhookBatch } from "../channels/core/types.js";

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function createMetaWebhookRouter(db: Database.Database, config: AppConfig, registry: AdapterRegistry) {
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
      const processBatch = (channel: ChannelType, batch: NormalizedWebhookBatch | undefined) => {
        for (const message of batch?.messages ?? []) {
          ingestInbound(db, channel, message);
          accepted += 1;
        }
        for (const status of batch?.statuses ?? []) {
          applyMessageStatus(db, channel, status);
          accepted += 1;
        }
      };
      processBatch("META_WHATSAPP", registry.get("META_WHATSAPP").handleWebhook?.(req.body));
      if (req.body?.object === "page") {
        processBatch("META_FACEBOOK", registry.get("META_FACEBOOK").handleWebhook?.(req.body));
      } else if (req.body?.object === "instagram") {
        processBatch("META_INSTAGRAM", registry.get("META_INSTAGRAM").handleWebhook?.(req.body));
      }
      return res.status(200).json({ accepted });
    } catch {
      return res.status(422).json({ error: { code: "WEBHOOK_PROCESSING_FAILED" } });
    }
  });
  return router;
}

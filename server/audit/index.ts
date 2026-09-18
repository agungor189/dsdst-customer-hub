import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { redact } from "../security/crypto.js";

export function writeAudit(db: Database.Database, input: { actorUserId?: string; action: string; entityType: string; entityId: string; ip?: string; payload?: unknown }) {
  db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,ip_address,payload_json) VALUES(?,?,?,?,?,?,?)")
    .run(randomUUID(), input.actorUserId ?? null, input.action, input.entityType, input.entityId, input.ip ?? null, JSON.stringify(redact(input.payload ?? {})));
}

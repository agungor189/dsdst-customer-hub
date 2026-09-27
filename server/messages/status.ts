import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ChannelType } from "../../shared/contracts/domain.js";
import type { NormalizedMessageStatus } from "../channels/core/types.js";

const progress: Record<string, number> = { QUEUED: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4 };

function parseMetadata(value: string): Record<string, unknown> {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

export function applyMessageStatus(db: Database.Database, channelType: ChannelType, input: NormalizedMessageStatus) {
  return db.transaction(() => {
    const duplicate = db.prepare("SELECT processed_at FROM webhook_events WHERE provider=? AND external_event_id=?")
      .get(channelType, input.eventId) as {processed_at:string|null}|undefined;
    if (duplicate?.processed_at) return {duplicate:true,updated:false};
    db.prepare("INSERT OR IGNORE INTO webhook_events(id,provider,external_event_id,signature_valid,payload_json) VALUES(?,?,?,?,?)")
      .run(randomUUID(),channelType,input.eventId,1,JSON.stringify(input));
    const account = db.prepare("SELECT id FROM channel_accounts WHERE channel_type=? AND external_account_id=?")
      .get(channelType,input.externalAccountId) as {id:string}|undefined;
    if (!account) throw new Error("CHANNEL_ACCOUNT_NOT_FOUND");
    const message = db.prepare("SELECT id,status,metadata_json FROM messages WHERE channel_account_id=? AND external_message_id=? AND direction='OUTBOUND'")
      .get(account.id,input.externalMessageId) as {id:string;status:string;metadata_json:string}|undefined;
    if (!message) throw new Error("OUTBOUND_MESSAGE_NOT_FOUND");

    const currentRank = progress[message.status] ?? -1;
    const nextRank = progress[input.status] ?? -1;
    const shouldUpdate = input.status === "FAILED"
      ? message.status !== "DELIVERED" && message.status !== "READ" && message.status !== "FAILED"
      : message.status !== "FAILED" && nextRank > currentRank;
    if (shouldUpdate) {
      const metadata = {...parseMetadata(message.metadata_json),...input.metadata};
      db.prepare("UPDATE messages SET status=?,metadata_json=?,sent_at=CASE WHEN ?='SENT' THEN COALESCE(sent_at,?) ELSE sent_at END WHERE id=?")
        .run(input.status,JSON.stringify(metadata),input.status,input.externalCreatedAt,message.id);
    }
    db.prepare("UPDATE webhook_events SET processed_at=CURRENT_TIMESTAMP WHERE provider=? AND external_event_id=?")
      .run(channelType,input.eventId);
    return {duplicate:false,updated:shouldUpdate};
  })();
}

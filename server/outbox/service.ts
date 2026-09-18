import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PanelUser } from "../../shared/contracts/domain.js";
import { writeAudit } from "../audit/index.js";

export function queueReply(db: Database.Database, conversationId: string, body: string, clientMessageId: string, actor: PanelUser, ip?: string) {
  return db.transaction(() => {
    const existing = db.prepare("SELECT id,status FROM messages WHERE client_message_id=?").get(clientMessageId) as any;
    if (existing) return { id: existing.id, status: existing.status, duplicate: true };
    const conversation = db.prepare("SELECT channel_account_id FROM conversations WHERE id=?").get(conversationId) as {channel_account_id:string}|undefined;
    if (!conversation) throw Object.assign(new Error("Conversation not found"), {status:404});
    const messageId=randomUUID(); const jobId=randomUUID();
    db.prepare("INSERT INTO messages(id,conversation_id,channel_account_id,client_message_id,direction,sender_type,sender_external_id,body_text,status) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(messageId,conversationId,conversation.channel_account_id,clientMessageId,"OUTBOUND","AGENT",actor.id,body,"QUEUED");
    db.prepare("INSERT INTO outbox_jobs(id,message_id) VALUES(?,?)").run(jobId,messageId);
    db.prepare("UPDATE conversations SET status='WAITING_CUSTOMER',last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(conversationId);
    db.prepare("INSERT INTO conversation_events(id,conversation_id,event_type,actor_user_id,payload_json) VALUES(?,?,?,?,?)").run(randomUUID(),conversationId,"MESSAGE_QUEUED",actor.id,JSON.stringify({message_id:messageId}));
    writeAudit(db,{actorUserId:actor.id,action:"MESSAGE_QUEUED",entityType:"message",entityId:messageId,ip,payload:{conversation_id:conversationId}});
    return {id:messageId,status:"QUEUED",duplicate:false};
  })();
}

export const retryDelaySeconds = (attempt: number) => Math.min(3600, Math.max(5, 5 * 2 ** Math.max(0, attempt - 1)));

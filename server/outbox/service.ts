import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ChannelType, PanelUser } from "../../shared/contracts/domain.js";
import { writeAudit } from "../audit/index.js";
import type { AdapterRegistry } from "../channels/core/registry.js";
import { ProviderError } from "../channels/core/types.js";

export function queueReply(db: Database.Database, registry: AdapterRegistry, conversationId: string, body: string, clientMessageId: string, actor: PanelUser, ip?: string) {
  return db.transaction(() => {
    const existing = db.prepare("SELECT id,status FROM messages WHERE client_message_id=?").get(clientMessageId) as any;
    if (existing) return { id: existing.id, status: existing.status, duplicate: true };
    const conversation = db.prepare("SELECT c.channel_account_id,c.external_conversation_id,c.metadata_json,a.external_account_id,a.channel_type FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id WHERE c.id=?").get(conversationId) as {channel_account_id:string;external_conversation_id:string;metadata_json:string;external_account_id:string;channel_type:string}|undefined;
    if (!conversation) throw Object.assign(new Error("Conversation not found"), {status:404});
    const adapter = registry.get(conversation.channel_type as ChannelType);
    if (adapter.validateReply) {
      try {
        adapter.validateReply(
          {messageId:"",externalConversationId:conversation.external_conversation_id,body,metadata:JSON.parse(conversation.metadata_json || "{}")},
          {db,phase:"QUEUE",id:conversation.channel_account_id,externalAccountId:conversation.external_account_id,credentials:null},
        );
      } catch (error) {
        if (error instanceof ProviderError) throw Object.assign(error,{status:400});
        throw error;
      }
    }
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

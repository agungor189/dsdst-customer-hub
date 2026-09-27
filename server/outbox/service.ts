import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ChannelType, PanelUser } from "../../shared/contracts/domain.js";
import { writeAudit } from "../audit/index.js";
import type { AdapterRegistry } from "../channels/core/registry.js";
import { ProviderError } from "../channels/core/types.js";

type QueueReplyOptions = { metadata?: Record<string,unknown>; messageType?: string; requiredChannel?: ChannelType; auditPayload?: Record<string,unknown> };

function queueOutbound(db: Database.Database, registry: AdapterRegistry, conversationId: string, body: string, clientMessageId: string, actor: PanelUser, ip?: string, options: QueueReplyOptions = {}) {
  return db.transaction(() => {
    const existing = db.prepare("SELECT id,status,conversation_id FROM messages WHERE client_message_id=?").get(clientMessageId) as any;
    if (existing) {
      if (existing.conversation_id !== conversationId) throw Object.assign(new Error("client_message_id is already used by another conversation"), {status:409,code:"IDEMPOTENCY_CONFLICT"});
      return { id: existing.id, status: existing.status, duplicate: true };
    }
    const conversation = db.prepare("SELECT c.channel_account_id,c.external_conversation_id,c.metadata_json,a.external_account_id,a.channel_type FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id WHERE c.id=?").get(conversationId) as {channel_account_id:string;external_conversation_id:string;metadata_json:string;external_account_id:string;channel_type:string}|undefined;
    if (!conversation) throw Object.assign(new Error("Conversation not found"), {status:404});
    if (options.requiredChannel && conversation.channel_type !== options.requiredChannel) throw Object.assign(new Error("Conversation channel does not support this message type"), {status:400,code:"CHANNEL_NOT_SUPPORTED"});
    const adapter = registry.get(conversation.channel_type as ChannelType);
    if (adapter.validateReply) {
      try {
        adapter.validateReply(
          {messageId:"",externalConversationId:conversation.external_conversation_id,body,metadata:{...JSON.parse(conversation.metadata_json || "{}"),...(options.metadata??{})}},
          {db,phase:"QUEUE",id:conversation.channel_account_id,externalAccountId:conversation.external_account_id,credentials:null},
        );
      } catch (error) {
        if (error instanceof ProviderError) throw Object.assign(error,{status:400});
        throw error;
      }
    }
    const messageId=randomUUID(); const jobId=randomUUID();
    db.prepare("INSERT INTO messages(id,conversation_id,channel_account_id,client_message_id,direction,sender_type,sender_external_id,body_text,message_type,status,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(messageId,conversationId,conversation.channel_account_id,clientMessageId,"OUTBOUND","AGENT",actor.id,body,options.messageType??"TEXT","QUEUED",JSON.stringify(options.metadata??{}));
    db.prepare("INSERT INTO outbox_jobs(id,message_id) VALUES(?,?)").run(jobId,messageId);
    db.prepare("UPDATE conversations SET status='WAITING_CUSTOMER',last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(conversationId);
    db.prepare("INSERT INTO conversation_events(id,conversation_id,event_type,actor_user_id,payload_json) VALUES(?,?,?,?,?)").run(randomUUID(),conversationId,"MESSAGE_QUEUED",actor.id,JSON.stringify({message_id:messageId}));
    writeAudit(db,{actorUserId:actor.id,action:"MESSAGE_QUEUED",entityType:"message",entityId:messageId,ip,payload:{conversation_id:conversationId,...(options.auditPayload??{})}});
    return {id:messageId,status:"QUEUED",duplicate:false};
  })();
}

export function queueReply(db: Database.Database, registry: AdapterRegistry, conversationId: string, body: string, clientMessageId: string, actor: PanelUser, ip?: string) {
  return queueOutbound(db,registry,conversationId,body,clientMessageId,actor,ip);
}

export function queueWhatsAppTemplate(db: Database.Database, registry: AdapterRegistry, conversationId: string, input: {
  templateName:string; languageCode:string; bodyParameters:string[]; headerParameters:string[]; clientMessageId:string;
}, actor: PanelUser, ip?: string) {
  const components = [
    ...(input.headerParameters.length ? [{type:"header",parameters:input.headerParameters.map(text=>({type:"text",text}))}] : []),
    ...(input.bodyParameters.length ? [{type:"body",parameters:input.bodyParameters.map(text=>({type:"text",text}))}] : []),
  ];
  return queueOutbound(db,registry,conversationId,`[WhatsApp Template: ${input.templateName}]`,input.clientMessageId,actor,ip,{
    requiredChannel:"META_WHATSAPP",
    messageType:"TEMPLATE",
    metadata:{whatsapp_mode:"TEMPLATE",template_name:input.templateName,language_code:input.languageCode,template_components:components},
    auditPayload:{whatsapp_mode:"TEMPLATE",template_name:input.templateName,language_code:input.languageCode},
  });
}

export const retryDelaySeconds = (attempt: number) => Math.min(3600, Math.max(5, 5 * 2 ** Math.max(0, attempt - 1)));

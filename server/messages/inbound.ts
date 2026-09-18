import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ChannelType } from "../../shared/contracts/domain.js";
import type { NormalizedInboundMessage } from "../channels/core/types.js";

const normalizeEmail = (value?: string) => value?.trim().toLowerCase() || null;

export function ingestInbound(db: Database.Database, channelType: ChannelType, input: NormalizedInboundMessage) {
  return db.transaction(() => {
    const duplicateEvent = db.prepare("SELECT processed_at FROM webhook_events WHERE provider=? AND external_event_id=?").get(channelType, input.eventId) as {processed_at: string|null}|undefined;
    if (duplicateEvent?.processed_at) return { duplicate: true, messageId: null, conversationId: null };
    db.prepare("INSERT OR IGNORE INTO webhook_events(id,provider,external_event_id,signature_valid,payload_json) VALUES(?,?,?,?,?)")
      .run(randomUUID(), channelType, input.eventId, 1, JSON.stringify(input));
    const account = db.prepare("SELECT id FROM channel_accounts WHERE channel_type=? AND external_account_id=?").get(channelType, input.externalAccountId) as {id:string}|undefined;
    if (!account) throw new Error("CHANNEL_ACCOUNT_NOT_FOUND");
    const duplicateMessage = db.prepare("SELECT id,conversation_id FROM messages WHERE channel_account_id=? AND external_message_id=?").get(account.id, input.externalMessageId) as any;
    if (duplicateMessage) {
      db.prepare("UPDATE webhook_events SET processed_at=CURRENT_TIMESTAMP WHERE provider=? AND external_event_id=?").run(channelType,input.eventId);
      return { duplicate: true, messageId: duplicateMessage.id, conversationId: duplicateMessage.conversation_id };
    }
    let identity = db.prepare("SELECT contact_id FROM contact_identities WHERE channel_account_id=? AND external_user_id=?").get(account.id,input.externalUserId) as {contact_id:string}|undefined;
    if (!identity) {
      const contactId = randomUUID();
      const email = channelType === "EMAIL" ? normalizeEmail(input.externalUserId) : null;
      db.prepare("INSERT INTO contacts(id,display_name,email,normalized_email) VALUES(?,?,?,?)").run(contactId,input.displayName,email,email);
      db.prepare("INSERT INTO contact_identities(id,contact_id,channel_type,channel_account_id,external_user_id,username,raw_metadata_json) VALUES(?,?,?,?,?,?,?)")
        .run(randomUUID(),contactId,channelType,account.id,input.externalUserId,input.username??null,JSON.stringify(input.metadata));
      identity = {contact_id:contactId};
    }
    let conversation = db.prepare("SELECT id FROM conversations WHERE channel_account_id=? AND external_conversation_id=?").get(account.id,input.externalConversationId) as {id:string}|undefined;
    if (!conversation) {
      conversation = {id:randomUUID()};
      db.prepare("INSERT INTO conversations(id,channel_account_id,contact_id,external_conversation_id,subject,status,last_message_at,unread_count,metadata_json) VALUES(?,?,?,?,?,'NEW',?,0,?)")
        .run(conversation.id,account.id,identity.contact_id,input.externalConversationId,input.subject??null,input.externalCreatedAt,JSON.stringify(input.metadata));
    }
    const messageId = randomUUID();
    db.prepare("INSERT INTO messages(id,conversation_id,channel_account_id,external_message_id,direction,sender_type,body_text,message_type,status,external_created_at,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
      .run(messageId,conversation.id,account.id,input.externalMessageId,"INBOUND","CUSTOMER",input.body,input.messageType,"RECEIVED",input.externalCreatedAt);
    db.prepare("UPDATE conversations SET status=CASE WHEN status IN ('CLOSED','RESOLVED') THEN 'OPEN' ELSE status END,last_message_at=?,unread_count=unread_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(input.externalCreatedAt,conversation.id);
    db.prepare("UPDATE webhook_events SET processed_at=CURRENT_TIMESTAMP WHERE provider=? AND external_event_id=?").run(channelType,input.eventId);
    return {duplicate:false,messageId,conversationId:conversation.id};
  })();
}

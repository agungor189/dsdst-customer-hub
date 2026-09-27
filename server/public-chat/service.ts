import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ingestInbound } from "../messages/inbound.js";

export const hashSessionToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const normalizeEmail = (value?: string) => value?.trim().toLowerCase() || null;
const normalizePhone = (value?: string) => {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `${trimmed.startsWith("+") ? "+" : ""}${digits}` : null;
};
const cleanName = (value?: string) => value?.trim().replace(/\s+/g, " ").slice(0, 120) || "Website Ziyaretçisi";
const urlContextKeys=new Set(["page_url","current_url","referrer","cart_url"]);
function sanitizeContext(input: Record<string, unknown>) {
  const safe:Record<string,string>={};
  for(const [key,value] of Object.entries(input)){
    if(typeof value!=="string"||!value)continue;
    if(!urlContextKeys.has(key)){safe[key]=value;continue;}
    try{
      const url=new URL(value);
      if(!["https:","http:"].includes(url.protocol)||url.username||url.password)continue;
      if(key==="cart_url"&&!/^\/cart\/?$/.test(url.pathname))continue;
      safe[key]=`${url.origin}${url.pathname}`.slice(0,2_000);
    }catch{}
  }
  return safe;
}

export type PublicSession = {
  id: string;
  channel_account_id: string;
  external_account_id: string;
  visitor_id: string;
  origin: string;
  display_name: string;
  email: string | null;
  normalized_email: string | null;
  phone: string | null;
  normalized_phone: string | null;
  conversation_id: string | null;
};

export function createWebsiteSession(db: Database.Database, input: {
  accountId: string; externalAccountId: string; origin: string; visitorId?: string; name?: string; email?: string; phone?: string;
}) {
  const token = randomBytes(32).toString("base64url");
  const visitorId = input.visitorId ?? `wv_${randomBytes(24).toString("base64url")}`;
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
  const name = cleanName(input.name);
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() || null;
  db.prepare(`INSERT INTO website_chat_sessions
    (id,channel_account_id,visitor_id,token_hash,origin,display_name,email,normalized_email,phone,normalized_phone,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.accountId,visitorId,hashSessionToken(token),input.origin,name,email,normalizeEmail(input.email),phone,normalizePhone(input.phone),expiresAt);
  return {token,visitorId,expiresAt,sessionId:id};
}

export function resolveWebsiteSession(db: Database.Database, token: string): PublicSession | null {
  const row = db.prepare(`SELECT s.id,s.channel_account_id,a.external_account_id,s.visitor_id,s.origin,s.display_name,s.email,s.normalized_email,
      s.phone,s.normalized_phone,s.conversation_id
    FROM website_chat_sessions s JOIN channel_accounts a ON a.id=s.channel_account_id
    WHERE s.token_hash=? AND datetime(s.expires_at)>datetime('now') AND a.channel_type='WEBSITE' AND a.status='ACTIVE'`)
    .get(hashSessionToken(token)) as PublicSession | undefined;
  if (row) db.prepare("UPDATE website_chat_sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  return row ?? null;
}

function findOpenConversation(db: Database.Database, session: PublicSession) {
  if (session.conversation_id) {
    const current = db.prepare("SELECT id,external_conversation_id,status FROM conversations WHERE id=? AND channel_account_id=?")
      .get(session.conversation_id,session.channel_account_id) as {id:string;external_conversation_id:string;status:string}|undefined;
    if (current && !["CLOSED","RESOLVED","SPAM"].includes(current.status)) return current;
  }
  return db.prepare(`SELECT c.id,c.external_conversation_id,c.status FROM conversations c
    JOIN contact_identities i ON i.contact_id=c.contact_id AND i.channel_account_id=c.channel_account_id
    WHERE c.channel_account_id=? AND i.external_user_id=? AND c.status NOT IN ('CLOSED','RESOLVED','SPAM')
    ORDER BY datetime(c.last_message_at) DESC LIMIT 1`).get(session.channel_account_id,session.visitor_id) as {id:string;external_conversation_id:string;status:string}|undefined;
}

export function ingestWebsiteMessage(db: Database.Database, session: PublicSession, input: {
  clientMessageId: string; body: string; context: Record<string, unknown>;
}) {
  return db.transaction(() => {
    const duplicate = db.prepare("SELECT id,conversation_id FROM messages WHERE channel_account_id=? AND external_message_id=?")
      .get(session.channel_account_id,input.clientMessageId) as {id:string;conversation_id:string}|undefined;
    if (duplicate) return {duplicate:true,messageId:duplicate.id,conversationId:duplicate.conversation_id};
    const repeated = db.prepare(`SELECT 1 FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      JOIN contact_identities i ON i.contact_id=c.contact_id AND i.channel_account_id=c.channel_account_id
      WHERE c.channel_account_id=? AND i.external_user_id=? AND m.direction='INBOUND' AND m.body_text=?
        AND datetime(m.created_at)>=datetime('now','-5 seconds') LIMIT 1`)
      .get(session.channel_account_id,session.visitor_id,input.body);
    if (repeated) throw Object.assign(new Error("Aynı mesaj çok hızlı tekrarlandı."),{status:429,code:"REPEATED_MESSAGE"});

    const open = findOpenConversation(db,session);
    const externalConversationId = open?.external_conversation_id ?? `website-${session.visitor_id}-${randomUUID()}`;
    const safeContext = sanitizeContext(input.context);
    const result = ingestInbound(db,"WEBSITE",{
      eventId:`website:${session.channel_account_id}:${input.clientMessageId}`,
      externalAccountId:session.external_account_id,
      externalConversationId,
      externalMessageId:input.clientMessageId,
      externalUserId:session.visitor_id,
      displayName:session.display_name,
      body:input.body,
      messageType:"TEXT",
      externalCreatedAt:new Date().toISOString(),
      metadata:{...safeContext,source:"website_widget"},
      email:session.email ?? undefined,
      phone:session.phone ?? undefined,
    });
    db.prepare("UPDATE website_chat_sessions SET conversation_id=?,last_seen_at=CURRENT_TIMESTAMP WHERE id=?").run(result.conversationId,session.id);
    if (result.conversationId) {
      db.prepare("UPDATE conversations SET metadata_json=json_patch(metadata_json,?) WHERE id=?")
        .run(JSON.stringify(safeContext),result.conversationId);
    }
    return result;
  })();
}

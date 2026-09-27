import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import sanitizeHtml from "sanitize-html";
import type { Capability } from "../../../shared/contracts/domain.js";
import { filterInboundAttachments, persistInboundAttachments, type PersistableAttachment } from "../../attachments/storage.js";
import { ingestInbound } from "../../messages/inbound.js";
import type { ChannelAccountContext, ChannelAdapter, ChannelSyncContext, OutboundEnvelope, ReplyValidationContext, SendResult } from "../core/types.js";
import { ProviderError } from "../core/types.js";
import { resolveEmailThread } from "./threading.js";
import { buildEmailBodies } from "./signature.js";

const UIDVALIDITY_CURSOR = "email_imap_uidvalidity";
const UID_CURSOR = "email_imap_last_uid";
const INITIAL_SYNC_DAYS = 7;
const INITIAL_SYNC_MAX_MESSAGES = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const capabilities: ReadonlySet<Capability> = new Set(["READ_MESSAGES","SEND_MESSAGES","POLLING","ATTACHMENTS","CUSTOMER_PROFILE"]);

export type EmailCredentials = {
  imap_host: string; imap_port: number; imap_secure: boolean;
  smtp_host: string; smtp_port: number; smtp_secure: boolean;
  username: string; password: string;
  from_address: string; from_name?: string; reply_to?: string; imap_mailbox: string;
  signature_enabled?: boolean; signature_html?: string;
};

export type EmailImapMessage = { uid: number; source: Buffer; internalDate?: Date };
export interface EmailImapClient {
  connect(): Promise<void>;
  open(mailbox: string): Promise<{uidValidity: string;uidNext?:number}>;
  search(query: {since?: Date; uid?: string}): Promise<number[]>;
  fetch(uid: number): Promise<EmailImapMessage | null>;
  close(): Promise<void>;
}
export interface EmailSmtpClient {
  send(input: Record<string,unknown>): Promise<{messageId?: string}>;
}
export interface EmailTransportFactory {
  imap(credentials: EmailCredentials): EmailImapClient;
  smtp(credentials: EmailCredentials): EmailSmtpClient;
}

function booleanCredential(value: string | undefined): boolean | null {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}

function portCredential(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const port=Number(value);
  return Number.isInteger(port)&&port>=1&&port<=65535?port:null;
}

export function normalizeMessageId(value: string | undefined | null): string | undefined {
  const trimmed=value?.trim().replace(/^mailto:/i,"");
  if (!trimmed) return undefined;
  const unwrapped=trimmed.replace(/^<|>$/g,"").trim();
  return unwrapped?`<${unwrapped}>`:undefined;
}

function addressList(value: AddressObject | AddressObject[] | undefined): string[] {
  return (Array.isArray(value)?value:[value]).flatMap(item=>item?.value??[]).map(item=>item.address?.trim().toLowerCase()).filter((item):item is string=>Boolean(item));
}

function firstAddress(value: AddressObject | AddressObject[] | undefined) {
  const entry=(Array.isArray(value)?value[0]:value)?.value?.[0];
  const address=entry?.address?.trim().toLowerCase();
  return address?{address,name:entry?.name?.trim()||address}:null;
}

function safeHtmlAndText(mail: ParsedMail) {
  const rawHtml=typeof mail.html==="string"?mail.html:"";
  const bodyHtml=rawHtml?sanitizeHtml(rawHtml,{
    allowedTags:["p","br","strong","b","em","i","u","ul","ol","li","blockquote","pre","code","a"],
    allowedAttributes:{a:["href","title"]},allowedSchemes:["http","https","mailto"],allowProtocolRelative:false,
  }):undefined;
  let body=mail.text?.trim()||"";
  if (!body&&bodyHtml) {
    const spaced=bodyHtml.replace(/<\/?(?:p|div|li|blockquote|pre|br)[^>]*>/gi,"\n");
    body=sanitizeHtml(spaced,{allowedTags:[],allowedAttributes:{}}).replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
  }
  return {body,bodyHtml};
}

function headerIds(value: string | string[] | undefined): string[] {
  const values=Array.isArray(value)?value:value?[value]:[];
  return values.flatMap(item=>item.match(/<[^>]+>|[^\s]+/g)??[]).map(normalizeMessageId).filter((item):item is string=>Boolean(item));
}

function stableHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function fallbackMessageId(accountId: string, uidValidity: string, uid: number) { return `<fallback-${stableHash(`${accountId}:${uidValidity}:${uid}`)}@customer-hub.local>`; }
export function outboundMessageId(messageId: string) { return `<hub-${stableHash(messageId)}@customer-hub.local>`; }
export function replySubject(subject: string | undefined) { const value=subject?.trim()||"(no subject)"; return /^re\s*:/i.test(value)?value:`Re: ${value}`; }

function mapProviderError(error: unknown, protocol: "IMAP"|"SMTP"): ProviderError {
  if (error instanceof ProviderError) return error;
  const value=error as {code?:string;responseCode?:number;message?:string;authenticationFailed?:boolean};
  const code=String(value?.code??"").toUpperCase();
  const responseCode=Number(value?.responseCode);
  const message=String(value?.message??"").toLowerCase();
  if (value?.authenticationFailed||code==="EAUTH"||/auth(?:entication)? failed|invalid credentials|login failed/.test(message)) return new ProviderError(`${protocol} authentication failed`,false,"AUTHENTICATION_FAILED");
  if (responseCode===429||/rate limit|too many requests|temporarily deferred/.test(message)) return new ProviderError(`${protocol} rate limit exceeded`,true,"RATE_LIMITED");
  if (/certificate|self[- ]signed|tls|ssl|hostname mismatch/.test(message)) return new ProviderError(`${protocol} TLS configuration is invalid`,false,"PROVIDER_CONFIGURATION_INVALID");
  if (code==="ENOTFOUND") return new ProviderError(`${protocol} host configuration is invalid`,false,"PROVIDER_CONFIGURATION_INVALID");
  if (protocol==="SMTP"&&Number.isFinite(responseCode)&&responseCode>=500) return new ProviderError("SMTP permanently rejected the message",false,"PROVIDER_VALIDATION_FAILED");
  if (protocol==="SMTP"&&Number.isFinite(responseCode)&&responseCode>=400) return new ProviderError("SMTP temporarily rejected the message",true,"PROVIDER_UNAVAILABLE");
  if (protocol==="SMTP"&&(code==="EENVELOPE"||code==="EMESSAGE")) return new ProviderError("SMTP rejected the message",false,"PROVIDER_VALIDATION_FAILED");
  if (["ETIMEDOUT","ECONNECTION","ECONNRESET","ECONNREFUSED","EAI_AGAIN","ESOCKET"].includes(code)) return new ProviderError(`${protocol} provider is unavailable`,true,"PROVIDER_UNAVAILABLE");
  return new ProviderError(`${protocol} provider is unavailable`,true,"PROVIDER_UNAVAILABLE");
}

function defaultFactory(timeoutMs: number): EmailTransportFactory {
  return {
    imap(credentials) {
      const client=new ImapFlow({host:credentials.imap_host,port:credentials.imap_port,secure:credentials.imap_secure,auth:{user:credentials.username,pass:credentials.password},logger:false,connectionTimeout:timeoutMs,greetingTimeout:timeoutMs,socketTimeout:timeoutMs});
      let lock:{release():void}|undefined;
      return {
        connect:()=>client.connect(),
        async open(mailbox) { lock=await client.getMailboxLock(mailbox); if(!client.mailbox) throw new Error("Mailbox did not open"); return {uidValidity:String(client.mailbox.uidValidity),uidNext:client.mailbox.uidNext}; },
        async search(query) { return (await client.search(query,{uid:true}))||[]; },
        async fetch(uid) { const result=await client.fetchOne(String(uid),{uid:true,source:true,internalDate:true},{uid:true}); if(!result||!result.source)return null; const date=result.internalDate?new Date(result.internalDate):undefined; return {uid:result.uid,source:result.source,internalDate:date}; },
        async close() { lock?.release(); if(!client.isClosed) await client.logout(); },
      };
    },
    smtp(credentials) {
      const transport=nodemailer.createTransport({host:credentials.smtp_host,port:credentials.smtp_port,secure:credentials.smtp_secure,auth:{user:credentials.username,pass:credentials.password},connectionTimeout:timeoutMs,greetingTimeout:timeoutMs,socketTimeout:timeoutMs});
      return {send:input=>transport.sendMail(input)};
    },
  };
}

export class EmailAdapter implements ChannelAdapter {
  readonly channelType="EMAIL" as const;
  readonly capabilities=capabilities;
  private readonly factory: EmailTransportFactory;
  private readonly now:()=>number;
  constructor(private readonly options:{timeoutMs:number;attachmentsDir:string;factory?:EmailTransportFactory;now?:()=>number}) { this.factory=options.factory??defaultFactory(options.timeoutMs); this.now=options.now??Date.now; }

  validateConfiguration(credentials: Record<string,string>|null, externalAccountId?: string) {
    const required=["imap_host","imap_port","imap_secure","smtp_host","smtp_port","smtp_secure","username","password"];
    const errors=required.filter(key=>!credentials?.[key]?.trim()).map(key=>`${key} is required`);
    if(credentials?.imap_port&&portCredential(credentials.imap_port)===null) errors.push("imap_port must be an integer between 1 and 65535");
    if(credentials?.smtp_port&&portCredential(credentials.smtp_port)===null) errors.push("smtp_port must be an integer between 1 and 65535");
    if(credentials?.imap_secure&&booleanCredential(credentials.imap_secure)===null) errors.push("imap_secure must be true or false");
    if(credentials?.smtp_secure&&booleanCredential(credentials.smtp_secure)===null) errors.push("smtp_secure must be true or false");
    if(credentials?.from_address&& !EMAIL_RE.test(credentials.from_address.trim())) errors.push("from_address must be a valid email address");
    if(credentials?.reply_to&& !EMAIL_RE.test(credentials.reply_to.trim())) errors.push("reply_to must be a valid email address");
    if(credentials?.username&& !credentials.from_address&& !EMAIL_RE.test(credentials.username.trim())) errors.push("from_address is required when username is not an email address");
    if(externalAccountId&& !EMAIL_RE.test(externalAccountId.trim())) errors.push("external_account_id must be a mailbox email address");
    return {valid:errors.length===0,errors};
  }

  validateReply(envelope:OutboundEnvelope,_context:ReplyValidationContext):void {
    const recipient=String(envelope.metadata.reply_to??envelope.metadata.customer_email??envelope.metadata.from??"").trim();
    if(!recipient) throw new ProviderError("Email conversation has no reply recipient",false,"EMAIL_RECIPIENT_MISSING");
    if(!EMAIL_RE.test(recipient)) throw new ProviderError("Email recipient is invalid",false,"PROVIDER_VALIDATION_FAILED");
    const length=[...envelope.body.trim()].length;
    if((length<1&&!envelope.attachments?.length)||length>20_000) throw new ProviderError("Email body or at least one attachment is required; body may not exceed 20000 characters",false,"PROVIDER_VALIDATION_FAILED");
  }

  async syncMessages(context:ChannelSyncContext):Promise<void> {
    const credentials=this.credentials(context.credentials,context.externalAccountId);
    const client=this.factory.imap(credentials);
    try {
      await client.connect();
      const mailbox=await client.open(credentials.imap_mailbox);
      const previousValidity=this.cursor(context,UIDVALIDITY_CURSOR);
      const previousUid=Number(this.cursor(context,UID_CURSOR));
      const incremental=previousValidity===mailbox.uidValidity&&Number.isInteger(previousUid)&&previousUid>=0;
      let uids=await client.search(incremental?{uid:`${previousUid+1}:*`}:{since:new Date(this.now()-INITIAL_SYNC_DAYS*24*60*60*1000)});
      uids=[...new Set(uids)].filter(uid=>Number.isInteger(uid)&&uid>0&&(incremental?uid>previousUid:true)).sort((a,b)=>a-b);
      if(!incremental) uids=uids.slice(-INITIAL_SYNC_MAX_MESSAGES);
      let lastUid=incremental?previousUid:Math.max(0,(mailbox.uidNext??1)-1);
      for(const uid of uids) {
        const fetched=await client.fetch(uid);
        if(!fetched) throw new ProviderError("IMAP message could not be fetched",true,"PROVIDER_UNAVAILABLE");
        await this.ingestMessage(context,credentials,mailbox.uidValidity,fetched);
        lastUid=Math.max(lastUid,uid);
      }
      this.storeCursors(context,mailbox.uidValidity,lastUid);
    } catch(error) { throw mapProviderError(error,"IMAP"); }
    finally { try { await client.close(); } catch { /* preserve the primary sync result/error */ } }
  }

  async sendMessage(envelope:OutboundEnvelope,account:ChannelAccountContext):Promise<SendResult> {
    const credentials=this.credentials(account.credentials,account.externalAccountId);
    this.validateReply(envelope,{...account,db:null as never,phase:"SEND"});
    const to=String(envelope.metadata.reply_to??envelope.metadata.customer_email??envelope.metadata.from).trim().toLowerCase();
    const latest=normalizeMessageId(String(envelope.metadata.latest_message_id??""));
    const root=normalizeMessageId(String(envelope.metadata.root_message_id??""));
    const references=headerIds(Array.isArray(envelope.metadata.references)?envelope.metadata.references.map(String):String(envelope.metadata.references??""));
    for(const id of [root,latest]) if(id&&!references.includes(id)) references.push(id);
    const messageId=outboundMessageId(envelope.messageId);
    const bodies=buildEmailBodies(envelope.body,Boolean(credentials.signature_enabled),credentials.signature_html);
    try {
      const result=await this.factory.smtp(credentials).send({
        from:credentials.from_name?{name:credentials.from_name,address:credentials.from_address}:credentials.from_address,
        to,replyTo:credentials.reply_to,subject:replySubject(String(envelope.metadata.subject??"")),text:bodies.text,html:bodies.html,
        attachments:(envelope.attachments??[]).map(attachment=>({filename:attachment.filename,content:attachment.content,contentType:attachment.mimeType})),
        messageId,inReplyTo:latest,references,
      });
      return {externalMessageId:normalizeMessageId(result.messageId)??messageId,status:"SENT"};
    } catch(error) { throw mapProviderError(error,"SMTP"); }
  }

  private async ingestMessage(context:ChannelSyncContext,credentials:EmailCredentials,uidValidity:string,fetched:EmailImapMessage) {
    const mail=await simpleParser(fetched.source,{skipHtmlToText:true,skipTextToHtml:true});
    const sender=firstAddress(mail.from);
    if(!sender||!EMAIL_RE.test(sender.address)) throw new ProviderError("Inbound email sender is invalid",false,"PROVIDER_VALIDATION_FAILED");
    const messageId=normalizeMessageId(mail.messageId)??fallbackMessageId(context.id,uidValidity,fetched.uid);
    const inReplyTo=normalizeMessageId(mail.inReplyTo);
    const references=headerIds(mail.references);
    const foundConversationId=resolveEmailThread({messageId,inReplyTo,references},candidate=>{
      const row=context.db.prepare("SELECT conversation_id FROM messages WHERE channel_account_id=? AND external_message_id=? LIMIT 1").get(context.id,candidate) as {conversation_id:string}|undefined;
      return row?.conversation_id??null;
    });
    const foundConversation=foundConversationId?context.db.prepare("SELECT external_conversation_id,metadata_json FROM conversations WHERE id=? AND channel_account_id=?").get(foundConversationId,context.id) as {external_conversation_id:string;metadata_json:string}|undefined:undefined;
    const externalConversationId=foundConversation?.external_conversation_id??`email-thread-${stableHash(messageId)}`;
    const {body,bodyHtml}=safeHtmlAndText(mail);
    const replyTo=firstAddress(mail.replyTo)?.address??sender.address;
    const attachments:PersistableAttachment[]=mail.attachments.map(item=>({filename:item.filename||"attachment",mimeType:item.contentType||"application/octet-stream",content:item.content}));
    const filtered=filterInboundAttachments(attachments);
    const date=mail.date instanceof Date&&Number.isFinite(mail.date.getTime())?mail.date:fetched.internalDate;
    const metadata:Record<string,unknown>={
      message_id:messageId,in_reply_to:inReplyTo,references,from:sender.address,reply_to:replyTo,to:addressList(mail.to),cc:addressList(mail.cc),
      uid:fetched.uid,uidvalidity:uidValidity,mailbox:credentials.imap_mailbox,skipped_attachments:filtered.skipped,
    };
    const ingested=ingestInbound(context.db,"EMAIL",{
      eventId:`email:${context.id}:${uidValidity}:${fetched.uid}`,externalAccountId:context.externalAccountId,externalConversationId,
      externalMessageId:messageId,externalUserId:sender.address,displayName:sender.name,body,subject:mail.subject?.trim()||undefined,
      messageType:"EMAIL",externalCreatedAt:(date??new Date(this.now())).toISOString(),metadata,
    });
    if(!ingested.messageId) throw new ProviderError("Inbound email message could not be resolved",true,"PROVIDER_UNAVAILABLE");
    if(bodyHtml) context.db.prepare("UPDATE messages SET body_html=? WHERE id=? AND body_html IS NULL").run(bodyHtml,ingested.messageId);
    persistInboundAttachments(context.db,this.options.attachmentsDir,ingested.messageId,filtered.accepted);
    const conversationId=ingested.conversationId??foundConversationId;
    if(!conversationId) throw new ProviderError("Inbound email conversation could not be resolved",true,"PROVIDER_UNAVAILABLE");
    let existing:Record<string,unknown>={};
    const row=context.db.prepare("SELECT metadata_json FROM conversations WHERE id=?").get(conversationId) as {metadata_json:string};
    try { existing=JSON.parse(row.metadata_json||"{}"); } catch { /* replace corrupt provider metadata safely */ }
    const root=normalizeMessageId(String(existing.root_message_id??""))??(inReplyTo||references.length?references[0]??inReplyTo:messageId)??messageId;
    const chain=headerIds([...(Array.isArray(existing.references)?existing.references.map(String):[]),...references,root,messageId]);
    context.db.prepare("UPDATE conversations SET subject=COALESCE(subject,?),metadata_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(mail.subject?.trim()||null,JSON.stringify({...existing,latest_message_id:messageId,root_message_id:root,references:chain,reply_to:replyTo,customer_email:sender.address,subject:mail.subject?.trim()||String(existing.subject??"")}),conversationId);
  }

  private credentials(value:Record<string,string>|null,externalAccountId?:string):EmailCredentials {
    const validation=this.validateConfiguration(value,externalAccountId);
    if(!validation.valid||!value) throw new ProviderError("Email account is not configured",false,"PROVIDER_CONFIGURATION_INVALID");
    return {imap_host:value.imap_host.trim(),imap_port:portCredential(value.imap_port)!,imap_secure:booleanCredential(value.imap_secure)!,smtp_host:value.smtp_host.trim(),smtp_port:portCredential(value.smtp_port)!,smtp_secure:booleanCredential(value.smtp_secure)!,username:value.username.trim(),password:value.password,from_address:(value.from_address||value.username).trim().toLowerCase(),from_name:value.from_name?.trim()||undefined,reply_to:value.reply_to?.trim().toLowerCase()||undefined,imap_mailbox:value.imap_mailbox?.trim()||"INBOX",signature_enabled:value.signature_enabled==="true",signature_html:value.signature_html||undefined};
  }
  private cursor(context:ChannelSyncContext,type:string) { return (context.db.prepare("SELECT cursor_value FROM sync_cursors WHERE channel_account_id=? AND cursor_type=?").get(context.id,type) as {cursor_value:string}|undefined)?.cursor_value; }
  private storeCursors(context:ChannelSyncContext,uidValidity:string,lastUid:number) {
    context.db.transaction(()=>{for(const [type,value] of [[UIDVALIDITY_CURSOR,uidValidity],[UID_CURSOR,String(lastUid)]]) context.db.prepare(`INSERT INTO sync_cursors(channel_account_id,cursor_type,cursor_value) VALUES(?,?,?) ON CONFLICT(channel_account_id,cursor_type) DO UPDATE SET cursor_value=excluded.cursor_value,updated_at=CURRENT_TIMESTAMP`).run(context.id,type,value);})();
  }
}

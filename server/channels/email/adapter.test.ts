import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../../test-utils.js";
import { MAX_ATTACHMENT_BYTES, filterInboundAttachments } from "../../attachments/storage.js";
import { ProviderError } from "../core/types.js";
import {
  EmailAdapter, fallbackMessageId, outboundMessageId, replySubject,
  type EmailCredentials, type EmailImapClient, type EmailImapMessage, type EmailTransportFactory,
} from "./adapter.js";

const credentialsRecord={imap_host:"imap.example.test",imap_port:"993",imap_secure:"true",smtp_host:"smtp.example.test",smtp_port:"465",smtp_secure:"1",username:"support@example.test",password:"super-secret",imap_mailbox:"INBOX"};
const normalizedCredentials:EmailCredentials={imap_host:"imap.example.test",imap_port:993,imap_secure:true,smtp_host:"smtp.example.test",smtp_port:465,smtp_secure:true,username:"support@example.test",password:"super-secret",from_address:"support@example.test",from_name:undefined,reply_to:undefined,imap_mailbox:"INBOX",signature_enabled:false,signature_html:undefined};

function rawEmail(input:{id?:string;from?:string;replyTo?:string;to?:string;subject?:string;inReplyTo?:string;references?:string;body?:string;html?:string;date?:string;attachments?:Array<{name:string;type:string;content:Buffer}>}) {
  const boundary="----hub-test-boundary";
  const headers=[
    input.id?`Message-ID: ${input.id}`:"",`From: ${input.from??"Alice Example <Alice@Example.COM>"}`,
    input.replyTo?`Reply-To: ${input.replyTo}`:"",`To: ${input.to??"support@example.test"}`,`Subject: ${input.subject??"Order question"}`,
    input.inReplyTo?`In-Reply-To: ${input.inReplyTo}`:"",input.references?`References: ${input.references}`:"",`Date: ${input.date??"Tue, 10 Sep 2024 10:00:00 +0000"}`,"MIME-Version: 1.0",
  ].filter(Boolean);
  if(input.attachments?.length) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`,"",`--${boundary}`,"Content-Type: text/plain; charset=utf-8","",input.body??"Attachment mail");
    for(const attachment of input.attachments) headers.push(`--${boundary}`,`Content-Type: ${attachment.type}; name="${attachment.name}"`,`Content-Disposition: attachment; filename="${attachment.name}"`,`Content-Transfer-Encoding: base64`,"",attachment.content.toString("base64"));
    headers.push(`--${boundary}--`,"");
  } else if(input.html!==undefined) {
    headers.push("Content-Type: text/html; charset=utf-8","",input.html);
  } else headers.push("Content-Type: text/plain; charset=utf-8","",input.body??"Hello from email");
  return Buffer.from(headers.join("\r\n"));
}

class MockImap implements EmailImapClient {
  queries:Array<{since?:Date;uid?:string}>=[]; fetched:number[]=[];
  constructor(public uidValidity:string,private messages:Map<number,EmailImapMessage>){}
  async connect(){}
  async open(){return{uidValidity:this.uidValidity,uidNext:Math.max(0,...this.messages.keys())+1};}
  async search(query:{since?:Date;uid?:string}){this.queries.push(query);if(query.uid){const start=Number(query.uid.split(":")[0]);return[...this.messages.keys()].filter(uid=>uid>=start);}return[...this.messages.keys()];}
  async fetch(uid:number){this.fetched.push(uid);return this.messages.get(uid)??null;}
  async close(){}
}

function harness(messages:Map<number,EmailImapMessage>,uidValidity="10",smtpSend:EmailTransportFactory["smtp"]=(/* credentials */)=>({send:async()=>({messageId:"<accepted@example.test>"})})) {
  const imap=new MockImap(uidValidity,messages);const imapCredentials:EmailCredentials[]=[];const smtpCredentials:EmailCredentials[]=[];
  const factory:EmailTransportFactory={imap:value=>{imapCredentials.push(value);return imap;},smtp:value=>{smtpCredentials.push(value);return smtpSend(value);}};
  return{imap,imapCredentials,smtpCredentials,factory};
}

function emailContext() {
  const state=testDatabase();
  const account=state.db.prepare("SELECT id,external_account_id FROM channel_accounts WHERE channel_type='EMAIL'").get() as {id:string;external_account_id:string};
  state.db.prepare("UPDATE channel_accounts SET external_account_id='support@example.test',status='ACTIVE' WHERE id=?").run(account.id);
  return{...state,context:{db:state.db,id:account.id,externalAccountId:"support@example.test",credentials:credentialsRecord}};
}

function assertProvider(error:unknown,code:string,retryable:boolean){assert.ok(error instanceof ProviderError);assert.equal(error.code,code);assert.equal(error.retryable,retryable);return true;}

test("email credential schema normalizes booleans/defaults and rejects invalid ports",async()=>{
  const {config}=testDatabase();const h=harness(new Map());const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:h.factory});
  assert.deepEqual(adapter.validateConfiguration(credentialsRecord,"support@example.test"),{valid:true,errors:[]});
  assert.match(adapter.validateConfiguration({...credentialsRecord,imap_port:"0",smtp_port:"65536"}).errors.join(" "),/imap_port.*smtp_port/);
  assert.match(adapter.validateConfiguration({...credentialsRecord,imap_secure:"yes"}).errors.join(" "),/imap_secure/);
  await adapter.syncMessages(emailContext().context);
  assert.deepEqual(h.imapCredentials[0],normalizedCredentials);
});

test("initial sync is seven-day bounded and capped to the latest 500 UIDs",async()=>{
  const {db,config,context}=emailContext();const messages=new Map<number,EmailImapMessage>();
  for(let uid=1;uid<=502;uid++)messages.set(uid,{uid,source:rawEmail({id:`<initial-${uid}@example.test>`,from:`User ${uid} <user${uid}@example.test>`})});
  const h=harness(messages);const now=1_725_968_000_000;const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:h.factory,now:()=>now});
  await adapter.syncMessages(context);
  assert.equal(h.imap.fetched.length,500);assert.equal(h.imap.fetched[0],3);assert.equal(h.imap.fetched.at(-1),502);
  assert.equal(h.imap.queries[0].since?.toISOString(),new Date(now-7*24*60*60*1000).toISOString());
  assert.equal((db.prepare("SELECT cursor_value FROM sync_cursors WHERE channel_account_id=? AND cursor_type='email_imap_last_uid'").get(context.id) as any).cursor_value,"502");db.close();
});

test("UID cursor progresses incrementally and UIDVALIDITY changes trigger safe bounded idempotent resync",async()=>{
  const {db,config,context}=emailContext();const messages=new Map([[1,{uid:1,source:rawEmail({id:"<same@example.test>"})}]]);const h=harness(messages,"10");const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:h.factory});
  await adapter.syncMessages(context);messages.set(2,{uid:2,source:rawEmail({id:"<second@example.test>"})});await adapter.syncMessages(context);
  assert.equal(h.imap.queries[1].uid,"2:*");h.imap.uidValidity="11";await adapter.syncMessages(context);
  assert.ok(h.imap.queries[2].since);assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE channel_account_id=? AND external_message_id IN ('<same@example.test>','<second@example.test>')").get(context.id) as any).count,2);
  assert.equal((db.prepare("SELECT count(DISTINCT conversation_id) count FROM messages WHERE channel_account_id=? AND external_message_id IN ('<same@example.test>','<second@example.test>')").get(context.id) as any).count,2);
  assert.equal((db.prepare("SELECT count(*) count FROM contacts WHERE normalized_email='alice@example.com'").get() as any).count,1);
  assert.equal((db.prepare("SELECT cursor_value FROM sync_cursors WHERE channel_account_id=? AND cursor_type='email_imap_uidvalidity'").get(context.id) as any).cursor_value,"11");db.close();
});

test("cursor advances only after the entire selected UID range is processed",async()=>{
  const {db,config,context}=emailContext();const messages=new Map([
    [1,{uid:1,source:rawEmail({id:"<cursor-one@example.test>"})}],
    [2,{uid:2,source:rawEmail({id:"<cursor-two@example.test>",from:"invalid sender"})}],
  ]);const h=harness(messages,"30");const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:h.factory});
  await assert.rejects(()=>adapter.syncMessages(context),error=>assertProvider(error,"PROVIDER_VALIDATION_FAILED",false));
  assert.equal(db.prepare("SELECT cursor_value FROM sync_cursors WHERE channel_account_id=? AND cursor_type='email_imap_last_uid'").get(context.id),undefined);
  messages.set(2,{uid:2,source:rawEmail({id:"<cursor-two@example.test>",from:"Bob <bob@example.test>"})});await adapter.syncMessages(context);
  assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE external_message_id IN ('<cursor-one@example.test>','<cursor-two@example.test>')").get() as any).count,2);
  assert.equal((db.prepare("SELECT cursor_value FROM sync_cursors WHERE channel_account_id=? AND cursor_type='email_imap_last_uid'").get(context.id) as any).cursor_value,"2");db.close();
});

test("account credentials and ingestion remain isolated between email accounts",async()=>{
  const {db,config,context}=emailContext();const secondId=randomUUID();db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,external_account_id) VALUES(?,'EMAIL','Other','ACTIVE','other@example.test')").run(secondId);
  const seen:string[]=[];const factory:EmailTransportFactory={imap:value=>{seen.push(value.username);const index=seen.length;return new MockImap("1",new Map([[1,{uid:1,source:rawEmail({id:`<account-${index}@mail.test>`,from:`Customer <customer-${index}@example.test>`})}]]));},smtp:()=>({send:async()=>({})})};
  const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory});await adapter.syncMessages(context);await adapter.syncMessages({...context,id:secondId,externalAccountId:"other@example.test",credentials:{...credentialsRecord,username:"other@example.test"}});
  assert.deepEqual(seen,["support@example.test","other@example.test"]);assert.equal((db.prepare("SELECT count(DISTINCT channel_account_id) count FROM messages WHERE external_message_id LIKE '<account-%@mail.test>'").get() as any).count,2);db.close();
});

test("mail parsing normalizes sender, text/HTML, sanitization and deterministic missing Message-ID",async()=>{
  const {db,config,context}=emailContext();const fallback=fallbackMessageId(context.id,"20",2);const messages=new Map([
    [1,{uid:1,source:rawEmail({id:"<plain@example.test>",from:"Alice Person <ALICE@EXAMPLE.COM>",body:"Plain body"})}],
    [2,{uid:2,source:rawEmail({from:"Bob <bob@example.test>",html:'<p>Hello <strong>world</strong></p><script>alert(1)</script><a href="javascript:evil()">bad</a>'})}],
  ]);const h=harness(messages,"20");const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:h.factory});await adapter.syncMessages(context);
  const plain=db.prepare("SELECT m.body_text,c.display_name,c.email,c.normalized_email FROM messages m JOIN conversations v ON v.id=m.conversation_id JOIN contacts c ON c.id=v.contact_id WHERE m.external_message_id='<plain@example.test>'").get() as any;
  assert.deepEqual(plain,{body_text:"Plain body",display_name:"Alice Person",email:"alice@example.com",normalized_email:"alice@example.com"});
  const html=db.prepare("SELECT body_text,body_html FROM messages WHERE external_message_id=?").get(fallback) as any;assert.match(html.body_text,/Hello world/);assert.doesNotMatch(html.body_html,/script|javascript|alert/);db.close();
});

test("In-Reply-To then reverse References thread replies; unrelated mail starts a new conversation",async()=>{
  const {db,config,context}=emailContext();const messages=new Map([
    [1,{uid:1,source:rawEmail({id:"<root@example.test>"})}],
    [2,{uid:2,source:rawEmail({id:"<reply@example.test>",inReplyTo:"<root@example.test>"})}],
    [3,{uid:3,source:rawEmail({id:"<reference@example.test>",references:"<missing@example.test> <root@example.test>"})}],
    [4,{uid:4,source:rawEmail({id:"<other@example.test>",subject:"Order question"})}],
  ]);const h=harness(messages);const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:h.factory});await adapter.syncMessages(context);
  const threaded=db.prepare("SELECT count(DISTINCT conversation_id) count FROM messages WHERE external_message_id IN ('<root@example.test>','<reply@example.test>','<reference@example.test>')").get() as any;assert.equal(threaded.count,1);
  assert.equal((db.prepare("SELECT count(DISTINCT conversation_id) count FROM messages WHERE external_message_id IN ('<root@example.test>','<other@example.test>')").get() as any).count,2);
  assert.equal((db.prepare("SELECT unread_count FROM conversations WHERE id=(SELECT conversation_id FROM messages WHERE external_message_id='<root@example.test>')").get() as any).unread_count,3);
  assert.equal((db.prepare("SELECT unread_count FROM conversations WHERE id=(SELECT conversation_id FROM messages WHERE external_message_id='<other@example.test>')").get() as any).unread_count,1);
  const metadata=JSON.parse((db.prepare("SELECT metadata_json FROM conversations WHERE id=(SELECT conversation_id FROM messages WHERE external_message_id='<reply@example.test>')").get() as any).metadata_json);assert.equal(metadata.latest_message_id,"<reference@example.test>");assert.equal(metadata.root_message_id,"<root@example.test>");db.close();
});

test("supported inbound attachments persist and unsafe attachments are skipped without dropping email",async()=>{
  const {db,config,context}=emailContext();const supported=["image/jpeg","image/png","image/webp","application/pdf"].map((type,index)=>({name:`../file ${index}.${index===3?"pdf":"img"}`,type,content:Buffer.from(`content-${index}`)}));supported.push({name:"run.exe",type:"application/octet-stream",content:Buffer.from("bad")});
  const h=harness(new Map([[1,{uid:1,source:rawEmail({id:"<attachments@example.test>",attachments:supported})}]]));const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:h.factory});await adapter.syncMessages(context);
  const message=db.prepare("SELECT id,metadata_json FROM messages WHERE external_message_id='<attachments@example.test>'").get() as any;assert.ok(message);assert.equal((db.prepare("SELECT count(*) count FROM attachments WHERE message_id=?").get(message.id) as any).count,4);
  const rows=db.prepare("SELECT filename,storage_path FROM attachments WHERE message_id=?").all(message.id) as any[];assert.ok(rows.every(row=>!row.filename.includes("/")&&fs.existsSync(`${config.attachmentsDir}/${row.storage_path}`)));
  assert.equal(JSON.parse(message.metadata_json).skipped_attachments[0].reason,"UNSUPPORTED_TYPE");db.close();
});

test("attachments over 10 MB are skipped by the shared safe filter",()=>{const result=filterInboundAttachments([{filename:"huge.pdf",mimeType:"application/pdf",content:Buffer.alloc(MAX_ATTACHMENT_BYTES+1)}]);assert.equal(result.accepted.length,0);assert.equal(result.skipped[0].reason,"TOO_LARGE");});

test("SMTP selects Reply-To, fallback From, stable thread headers and reports SENT",async()=>{
  const {config}=testDatabase();let sent:Record<string,any>|undefined;const h=harness(new Map(),"1",()=>({send:async input=>{sent=input;return{messageId:undefined};}}));const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:h.factory});
  const envelope={messageId:"hub-message-1",externalConversationId:"thread",body:"Reply text",metadata:{reply_to:"reply@example.test",customer_email:"from@example.test",subject:"Re: Existing",latest_message_id:"<latest@example.test>",root_message_id:"<root@example.test>",references:["<root@example.test>"]}};
  const result=await adapter.sendMessage(envelope,{id:"a",externalAccountId:"support@example.test",credentials:credentialsRecord});assert.equal(result.status,"SENT");assert.equal(result.externalMessageId,outboundMessageId("hub-message-1"));assert.equal(sent!.to,"reply@example.test");assert.equal(sent!.from,"support@example.test");assert.equal(sent!.subject,"Re: Existing");assert.equal(sent!.inReplyTo,"<latest@example.test>");assert.deepEqual(sent!.references,["<root@example.test>","<latest@example.test>"]);
  assert.equal(replySubject("Question"),"Re: Question");assert.equal(outboundMessageId("hub-message-1"),outboundMessageId("hub-message-1"));
});

test("SMTP adds one sanitized account signature and safe attachments without mutating the reply",async()=>{
  const {config}=testDatabase();const sends:Record<string,any>[]=[];const h=harness(new Map(),"1",()=>({send:async input=>{sends.push(input);return{messageId:"<sent@example.test>"};}}));const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:h.factory});
  const signature='<table style="border-collapse:collapse"><tbody><tr><td><strong>DSDST</strong><script>alert(1)</script><img src="https://cdn.example.test/logo.png" onerror="alert(1)" width="80"><a href="javascript:alert(1)" target="_blank">bad</a><a href="mailto:support@example.test" target="_blank">support</a></td></tr></tbody></table>';
  const envelope={messageId:"signed-1",externalConversationId:"thread",body:"Merhaba\nDünya",metadata:{reply_to:"customer@example.test",subject:"Order"},attachments:[{filename:"invoice.pdf",mimeType:"application/pdf",content:Buffer.from("%PDF-test")}]};
  const account={id:"a",externalAccountId:"support@example.test",credentials:{...credentialsRecord,signature_enabled:"true",signature_html:signature}};
  await adapter.sendMessage(envelope,account);await adapter.sendMessage(envelope,account);
  for(const sent of sends){assert.equal(sent.text,"Merhaba\nDünya\n\nDSDSTbadsupport");assert.match(sent.html,/Merhaba<br>Dünya<br><br>/);assert.match(sent.html,/<table/);assert.match(sent.html,/https:\/\/cdn\.example\.test\/logo\.png/);assert.doesNotMatch(sent.html,/script|onerror|javascript:/i);assert.equal((sent.html.match(/DSDST/g)??[]).length,1);assert.deepEqual(sent.attachments,[{filename:"invoice.pdf",content:Buffer.from("%PDF-test"),contentType:"application/pdf"}]);}
  assert.equal(envelope.body,"Merhaba\nDünya");
});

test("email reply validation requires recipient and generic body limits",()=>{const {config}=testDatabase();const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:harness(new Map()).factory});const context={id:"a",externalAccountId:"support@example.test",credentials:null,db:null as never,phase:"QUEUE" as const};
  assert.throws(()=>adapter.validateReply({messageId:"x",externalConversationId:"x",body:"ok",metadata:{}},context),error=>assertProvider(error,"EMAIL_RECIPIENT_MISSING",false));
  assert.throws(()=>adapter.validateReply({messageId:"x",externalConversationId:"x",body:" ",metadata:{reply_to:"valid@example.test"}},context),error=>assertProvider(error,"PROVIDER_VALIDATION_FAILED",false));
  assert.doesNotThrow(()=>adapter.validateReply({messageId:"x",externalConversationId:"x",body:"",metadata:{reply_to:"valid@example.test"},attachments:[{filename:"x.pdf",mimeType:"application/pdf",content:Buffer.from("%PDF-")}]},context));
  assert.throws(()=>adapter.validateReply({messageId:"x",externalConversationId:"x",body:"x".repeat(20_001),metadata:{reply_to:"valid@example.test"}},context),error=>assertProvider(error,"PROVIDER_VALIDATION_FAILED",false));
});

for(const [name,error,code,retryable] of [
  ["auth",{code:"EAUTH",message:"bad super-secret"},"AUTHENTICATION_FAILED",false],
  ["timeout",{code:"ETIMEDOUT",message:"timeout super-secret"},"PROVIDER_UNAVAILABLE",true],
  ["transient",{responseCode:450,message:"try later super-secret"},"PROVIDER_UNAVAILABLE",true],
  ["permanent",{responseCode:550,message:"recipient rejected super-secret"},"PROVIDER_VALIDATION_FAILED",false],
] as const)test(`SMTP ${name} error mapping is safe`,async()=>{const {config}=testDatabase();const h=harness(new Map(),"1",()=>({send:async()=>{throw error;}}));const adapter=new EmailAdapter({timeoutMs:100,attachmentsDir:config.attachmentsDir,factory:h.factory});await assert.rejects(()=>adapter.sendMessage({messageId:"x",externalConversationId:"x",body:"hello",metadata:{reply_to:"valid@example.test"}},{id:"a",externalAccountId:"support@example.test",credentials:credentialsRecord}),caught=>{assertProvider(caught,code,retryable);assert.doesNotMatch((caught as Error).message,/super-secret/);return true;});});

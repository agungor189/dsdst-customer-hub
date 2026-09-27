import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { testDatabase } from "../test-utils.js";
import { encryptSecret } from "../security/crypto.js";
import { createAdapterRegistry } from "../channels/core/registry.js";
import { OutboxWorker } from "../outbox/worker.js";
import { createApp } from "../app.js";
import { queueReply } from "../outbox/service.js";
import { applyMessageStatus } from "../messages/status.js";

const origin="https://dsdst.com"; const siteId="dsdst-shopify-tr";
const admin={id:"admin",username:"Admin",role:"admin" as const,permissions:{}};

function configuredApp(){
  const {db,config}=testDatabase();
  const credentials={site_id:siteId,site_name:"DSDST",allowed_origins:JSON.stringify([origin])};
  db.prepare("UPDATE channel_accounts SET external_account_id=?,encrypted_credentials=?,status='ACTIVE' WHERE channel_type='WEBSITE'")
    .run(siteId,encryptSecret(credentials,config.encryptionKey));
  const registry=createAdapterRegistry(config);const worker=new OutboxWorker(db,registry,config);
  const server=createApp({db,config,registry,worker,verify:async()=>admin}).listen(0);
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=(path:string,init:RequestInit={},requestSite=siteId,requestOrigin=origin)=>fetch(`${base}${path}`,{...init,headers:{origin:requestOrigin,"X-DSDST-Site-ID":requestSite,...init.headers}});
  const close=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();};
  return{db,config,registry,worker,request,close};
}
async function createSession(request:ReturnType<typeof configuredApp>["request"],body:Record<string,unknown>={}){
  const response=await request("/api/public/chat/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({site_id:siteId,...body})});
  return{response,body:await response.json() as any};
}
const authed=(token:string,body?:unknown):RequestInit=>({headers:{authorization:`Bearer ${token}`,...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});

test("public chat enforces origin, creates random hashed account-scoped sessions",async()=>{
  const app=configuredApp();try{
    const denied=await app.request("/api/public/chat/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({site_id:siteId})},siteId,"https://evil.example");assert.equal(denied.status,403);
    const first=await createSession(app.request);const second=await createSession(app.request);assert.equal(first.response.status,201);assert.notEqual(first.body.session_token,second.body.session_token);assert.match(first.body.visitor_id,/^wv_/);
    const stored=app.db.prepare("SELECT token_hash FROM website_chat_sessions WHERE visitor_id=?").get(first.body.visitor_id)as any;assert.notEqual(stored.token_hash,first.body.session_token);assert.equal(stored.token_hash.length,64);
    const invalid=await app.request("/api/public/chat/messages",{...authed("A".repeat(43)),method:"GET"});assert.equal(invalid.status,401);
  }finally{await app.close();}
});

test("inbound website chat is idempotent, normalized, plain text, and reuses an open conversation",async()=>{
  const app=configuredApp();try{
    const session=await createSession(app.request,{name:"  Ada   Yılmaz ",email:" ADA@EXAMPLE.COM ",phone:"+90 (555) 123 45 67"});const token=session.body.session_token;
    const clientId=randomUUID();const payload={client_message_id:clientId,body:"<img src=x onerror=alert(1)>",context:{product_id:"123",product_handle:"30x30-3-yollu",product_title:"30x30 3 Yollu",variant_id:"456",current_url:"https://dsdst.com/products/30x30?customer_token=secret"}};
    const first=await app.request("/api/public/chat/messages",{...authed(token,payload),method:"POST"});assert.equal(first.status,202);const result=await first.json()as any;
    const duplicate=await app.request("/api/public/chat/messages",{...authed(token,payload),method:"POST"});assert.equal(duplicate.status,200);assert.equal((await duplicate.json()as any).duplicate,true);
    const next=await app.request("/api/public/chat/messages",{...authed(token,{client_message_id:randomUUID(),body:"İkinci mesaj",context:{}}),method:"POST"});assert.equal(next.status,202);assert.equal((await next.json()as any).conversation_id,result.conversation_id);
    const contact=app.db.prepare("SELECT display_name,normalized_email,normalized_phone FROM contacts c JOIN conversations v ON v.contact_id=c.id WHERE v.id=?").get(result.conversation_id)as any;assert.deepEqual(contact,{display_name:"Ada Yılmaz",normalized_email:"ada@example.com",normalized_phone:"+905551234567"});
    const message=app.db.prepare("SELECT body_text,body_html FROM messages WHERE external_message_id=?").get(clientId)as any;assert.equal(message.body_text,payload.body);assert.equal(message.body_html,null);
    const conversation=app.db.prepare("SELECT metadata_json FROM conversations WHERE id=?").get(result.conversation_id)as any;const metadata=JSON.parse(conversation.metadata_json);assert.equal(metadata.product_title,"30x30 3 Yollu");assert.equal(metadata.current_url,"https://dsdst.com/products/30x30");assert.equal(JSON.stringify(metadata).includes("secret"),false);
    const empty=await app.request("/api/public/chat/messages",{...authed(token,{client_message_id:randomUUID(),body:"   ",context:{}}),method:"POST"});assert.equal(empty.status,400);
    const long=await app.request("/api/public/chat/messages",{...authed(token,{client_message_id:randomUUID(),body:"x".repeat(2001),context:{}}),method:"POST"});assert.equal(long.status,400);
  }finally{await app.close();}
});

test("agent reply flows through outbox to SENT, widget fetch to DELIVERED, and visible ACK to READ",async()=>{
  const app=configuredApp();try{
    const session=await createSession(app.request);const token=session.body.session_token;
    const inbound=await app.request("/api/public/chat/messages",{...authed(token,{client_message_id:randomUUID(),body:"Yardım",context:{}}),method:"POST"});const conversationId=(await inbound.json()as any).conversation_id;
    const queued=queueReply(app.db,app.registry,conversationId,"Elbette",randomUUID(),admin);await app.worker.tick();
    let row=app.db.prepare("SELECT status,external_message_id FROM messages WHERE id=?").get(queued.id)as any;assert.equal(row.status,"SENT");
    const fetched=await app.request("/api/public/chat/messages",{...authed(token),method:"GET"});assert.equal(fetched.status,200);const outbound=(await fetched.json()as any).items.find((item:any)=>item.id===queued.id);assert.equal(outbound.status,"DELIVERED");
    const read=await app.request("/api/public/chat/read",{...authed(token,{message_ids:[queued.id]}),method:"POST"});assert.equal(read.status,204);assert.equal((app.db.prepare("SELECT status FROM messages WHERE id=?").get(queued.id)as any).status,"READ");
    const downgrade=applyMessageStatus(app.db,"WEBSITE",{eventId:randomUUID(),externalAccountId:siteId,externalMessageId:row.external_message_id,status:"DELIVERED",externalCreatedAt:new Date().toISOString(),metadata:{}});assert.equal(downgrade.updated,false);assert.equal((app.db.prepare("SELECT status FROM messages WHERE id=?").get(queued.id)as any).status,"READ");
  }finally{await app.close();}
});

test("closed conversations create a new thread and tokens cannot cross website accounts",async()=>{
  const app=configuredApp();try{
    const first=await createSession(app.request);const initial=await app.request("/api/public/chat/messages",{...authed(first.body.session_token,{client_message_id:randomUUID(),body:"İlk",context:{}}),method:"POST"});const firstConversation=(await initial.json()as any).conversation_id;
    app.db.prepare("UPDATE conversations SET status='CLOSED',closed_at=CURRENT_TIMESTAMP WHERE id=?").run(firstConversation);
    const nextSession=await createSession(app.request,{visitor_id:first.body.visitor_id});const next=await app.request("/api/public/chat/messages",{...authed(nextSession.body.session_token,{client_message_id:randomUUID(),body:"Yeni",context:{}}),method:"POST"});assert.notEqual((await next.json()as any).conversation_id,firstConversation);
    const secondId="second-site";app.db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,encrypted_credentials,external_account_id) VALUES(?, 'WEBSITE','Second','ACTIVE',?,?)")
      .run(randomUUID(),encryptSecret({site_id:secondId,site_name:"Second",allowed_origins:JSON.stringify([origin])},app.config.encryptionKey),secondId);
    const isolated=await app.request("/api/public/chat/messages",{...authed(first.body.session_token),method:"GET"},secondId);assert.equal(isolated.status,403);
  }finally{await app.close();}
});

test("public chat blocks repeated-message spam and rate-limits session creation by IP",async()=>{
  const app=configuredApp();try{
    const session=await createSession(app.request);const payload={client_message_id:randomUUID(),body:"Aynı mesaj",context:{}};assert.equal((await app.request("/api/public/chat/messages",{...authed(session.body.session_token,payload),method:"POST"})).status,202);
    const repeated=await app.request("/api/public/chat/messages",{...authed(session.body.session_token,{...payload,client_message_id:randomUUID()}),method:"POST"});assert.equal(repeated.status,429);
  }finally{await app.close();}
  const limited=configuredApp();try{let last=0;for(let index=0;index<21;index++)last=(await createSession(limited.request)).response.status;assert.equal(last,429);}finally{await limited.close();}
});

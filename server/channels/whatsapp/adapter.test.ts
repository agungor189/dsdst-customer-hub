import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { testDatabase } from "../../test-utils.js";
import { ProviderError } from "../core/types.js";
import type { AdapterRegistry } from "../core/registry.js";
import { WhatsAppCloudAdapter, normalizeWhatsAppWebhook } from "./adapter.js";
import { ingestInbound } from "../../messages/inbound.js";
import { applyMessageStatus } from "../../messages/status.js";
import { queueReply, queueWhatsAppTemplate } from "../../outbox/service.js";
import { OutboxWorker } from "../../outbox/worker.js";
import { encryptSecret } from "../../security/crypto.js";
import { createAdapterRegistry } from "../core/registry.js";
import { createApp } from "../../app.js";
import { whatsappTemplateSendSchema } from "../../../shared/schemas/api.js";

const credentials = {
  access_token:"top-secret-token",
  phone_number_id:"phone-1",
  business_account_id:"business-1",
  graph_api_version:"v23.0",
};
const account = {id:"account-1",externalAccountId:"phone-1",credentials};
const envelope = {messageId:"hub-message-1",externalConversationId:"905551112233",body:"Merhaba!",metadata:{}};
const admin = {id:"admin",username:"Admin",role:"admin" as const,permissions:{}};

function response(body: unknown, status=200) {
  return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
}

function expectProvider(code:string,retryable:boolean) {
  return (error:unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code,code);
    assert.equal(error.retryable,retryable);
    return true;
  };
}

function inboundPayload(input: {phone?:string;from?:string;id?:string;type?:string;timestamp?:string;name?:string}={}) {
  const type=input.type??"text";
  const content=type==="text"?{text:{body:"Siparişim nerede?"}}:{[type]:{id:"media-77",mime_type:type==="image"?"image/jpeg":"application/octet-stream",filename:type==="document"?"fatura.pdf":undefined}};
  return {object:"whatsapp_business_account",entry:[{id:"business-1",changes:[{field:"messages",value:{
    messaging_product:"whatsapp",metadata:{phone_number_id:input.phone??"phone-1"},
    contacts:[{wa_id:input.from??"905551112233",profile:{name:input.name??"Ayşe"}}],
    messages:[{from:input.from??"905551112233",id:input.id??"wamid.in-1",timestamp:input.timestamp??"1700000000",type,...content}],
  }}]}]};
}

function statusPayload(status:string,id="wamid.out-1",phone="phone-1",timestamp="1700000100",errors?:unknown[]) {
  return {object:"whatsapp_business_account",entry:[{id:"business-1",changes:[{field:"messages",value:{
    messaging_product:"whatsapp",metadata:{phone_number_id:phone},statuses:[{id,status,timestamp,recipient_id:"905551112233",errors}],
  }}]}]};
}

function installAccount(db:Database.Database, phone="phone-1") {
  const seeded=db.prepare("SELECT id FROM channel_accounts WHERE channel_type='META_WHATSAPP' LIMIT 1").get() as {id:string};
  db.prepare("UPDATE channel_accounts SET external_account_id=?,status='ACTIVE' WHERE id=?").run(phone,seeded.id);
  return seeded.id;
}

function registryFor(adapter:WhatsAppCloudAdapter):AdapterRegistry {
  return {get:()=>adapter,list:()=>[]} as unknown as AdapterRegistry;
}

test("WhatsApp credentials require token, phone id and a provider-owned vXX.X Graph version",()=>{
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async()=>response({})});
  const missing=adapter.validateConfiguration({access_token:"x",phone_number_id:"p"});
  assert.equal(missing.valid,false);
  assert.ok(missing.errors.includes("graph_api_version is required"));
  assert.match(adapter.validateConfiguration({...credentials,graph_api_version:"23.0"}).errors.join(" "),/vXX\.X/);
  assert.match(adapter.validateConfiguration(credentials,"different-phone").errors.join(" "),/external_account_id/);
  assert.deepEqual(adapter.validateConfiguration(credentials),{valid:true,errors:[]});
});

test("outbound text uses Bearer auth, configured Graph endpoint and WhatsApp body",async()=>{
  let captured:{url:string;init?:RequestInit}|undefined;
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async(input,init)=>{captured={url:String(input),init};return response({messages:[{id:"wamid.out-1"}]});}});
  const result=await adapter.sendMessage(envelope,account);
  assert.deepEqual(result,{externalMessageId:"wamid.out-1",status:"SENT"});
  assert.equal(captured!.url,"https://graph.facebook.com/v23.0/phone-1/messages");
  const headers=new Headers(captured!.init?.headers);
  assert.equal(headers.get("authorization"),"Bearer top-secret-token");
  assert.equal(headers.get("content-type"),"application/json");
  assert.deepEqual(JSON.parse(String(captured!.init?.body)),{
    messaging_product:"whatsapp",recipient_type:"individual",to:"905551112233",type:"text",text:{preview_url:false,body:"Merhaba!"},
  });
});

test("mark-read uses the account-scoped messages endpoint",async()=>{
  let body:unknown;
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async(_input,init)=>{body=JSON.parse(String(init?.body));return response({success:true});}});
  await adapter.markRead("wamid.in-1",account);
  assert.deepEqual(body,{messaging_product:"whatsapp",status:"read",message_id:"wamid.in-1"});
});

test("template list requires a WABA id",async()=>{
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async()=>response({})});
  const {business_account_id:_businessAccountId,...credentialsWithoutWaba}=credentials;
  await assert.rejects(()=>adapter.listWhatsAppTemplates!({...account,credentials:credentialsWithoutWaba}),expectProvider("WHATSAPP_WABA_REQUIRED",false));
});

test("template list uses WABA Bearer auth, bounded cursor pagination and safe normalization",async()=>{
  const calls:Array<{url:string;authorization:string|null}>=[];
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async(input,init)=>{
    const url=String(input);calls.push({url,authorization:new Headers(init?.headers).get("authorization")});
    if(calls.length===1)return response({data:[{id:"1",name:"order_update",language:"tr",category:"UTILITY",status:"APPROVED",quality_score:{score:"GREEN"},components:[{type:"BODY",text:"Merhaba {{1}}"}]}],paging:{next:"provider-next-url",cursors:{after:"cursor-2"}}});
    return response({data:[{id:"2",name:"promo",language:"tr",category:"MARKETING",status:"PENDING",components:[{type:"HEADER",format:"TEXT",text:"Duyuru"}]},{id:"3",name:"old_promo",language:"en_US",category:"MARKETING",status:"REJECTED",components:[]}],paging:{}});
  }});
  const templates=await adapter.listWhatsAppTemplates!(account);
  assert.equal(calls.length,2);
  assert.match(calls[0].url,/\/v23\.0\/business-1\/message_templates\?/);
  assert.match(calls[0].url,/limit=100/);
  assert.match(calls[1].url,/after=cursor-2/);
  assert.deepEqual(calls.map(call=>call.authorization),["Bearer top-secret-token","Bearer top-secret-token"]);
  assert.deepEqual(templates.map(item=>({name:item.name,status:item.status})),[
    {name:"order_update",status:"APPROVED"},{name:"promo",status:"PENDING"},{name:"old_promo",status:"REJECTED"},
  ]);
  assert.equal(templates[0].components[0].text,"Merhaba {{1}}");
  assert.doesNotMatch(JSON.stringify(templates),/top-secret-token/);
});

test("template send uses the phone number endpoint, recipient, language and body/header text parameters",async()=>{
  let captured:{url:string;body:any}|undefined;
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async(input,init)=>{captured={url:String(input),body:JSON.parse(String(init?.body))};return response({messages:[{id:"wamid.template-1"}]});}});
  const result=await adapter.sendMessage({...envelope,metadata:{
    whatsapp_mode:"TEMPLATE",template_name:"order_update",language_code:"tr",
    template_components:[
      {type:"header",parameters:[{type:"text",text:"Sipariş"}]},
      {type:"body",parameters:[{type:"text",text:"Alper"},{type:"text",text:"12345"}]},
    ],
  }},account);
  assert.deepEqual(result,{externalMessageId:"wamid.template-1",status:"SENT"});
  assert.equal(captured!.url,"https://graph.facebook.com/v23.0/phone-1/messages");
  assert.deepEqual(captured!.body,{
    messaging_product:"whatsapp",recipient_type:"individual",to:"905551112233",type:"template",
    template:{name:"order_update",language:{code:"tr"},components:[
      {type:"header",parameters:[{type:"text",text:"Sipariş"}]},
      {type:"body",parameters:[{type:"text",text:"Alper"},{type:"text",text:"12345"}]},
    ]},
  });
});

test("template validation rejects non-approved, missing and unsupported complex templates",async()=>{
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async()=>response({data:[
    {id:"1",name:"approved",language:"tr",category:"UTILITY",status:"APPROVED",components:[{type:"BODY",text:"Merhaba {{1}}"}]},
    {id:"2",name:"pending",language:"tr",category:"UTILITY",status:"PENDING",components:[]},
    {id:"3",name:"media",language:"tr",category:"UTILITY",status:"APPROVED",components:[{type:"HEADER",format:"IMAGE"}]},
    {id:"4",name:"flow",language:"tr",category:"UTILITY",status:"APPROVED",components:[{type:"BUTTONS",buttons:[{type:"FLOW",text:"Aç"}]}]},
  ]})});
  await adapter.validateWhatsAppTemplate!(account,"approved","tr",{body:["Alper"],header:[]});
  await assert.rejects(()=>adapter.validateWhatsAppTemplate!(account,"pending","tr",{body:[],header:[]}),expectProvider("WHATSAPP_TEMPLATE_NOT_APPROVED",false));
  await assert.rejects(()=>adapter.validateWhatsAppTemplate!(account,"missing","tr",{body:[],header:[]}),expectProvider("WHATSAPP_TEMPLATE_NOT_FOUND",false));
  await assert.rejects(()=>adapter.validateWhatsAppTemplate!(account,"media","tr",{body:[],header:[]}),expectProvider("WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED",false));
  await assert.rejects(()=>adapter.validateWhatsAppTemplate!(account,"flow","tr",{body:[],header:[]}),expectProvider("WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED",false));
  await assert.rejects(()=>adapter.validateWhatsAppTemplate!(account,"approved","tr",{body:[],header:[]}),expectProvider("PROVIDER_VALIDATION_FAILED",false));
});

test("template metadata cache is isolated by Hub account, phone number and WABA",async()=>{
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async input=>{
    const url=String(input);
    if(url.includes("/business-1/"))return response({data:[{id:"1",name:"account_one",language:"tr",category:"UTILITY",status:"APPROVED",components:[]}]});
    return response({data:[{id:"2",name:"account_two",language:"tr",category:"UTILITY",status:"APPROVED",components:[]}]});
  }});
  await adapter.validateWhatsAppTemplate!(account,"account_one","tr",{body:[],header:[]});
  const second={id:"account-2",externalAccountId:"phone-2",credentials:{...credentials,phone_number_id:"phone-2",business_account_id:"business-2"}};
  await adapter.validateWhatsAppTemplate!(second,"account_two","tr",{body:[],header:[]});
  await assert.rejects(()=>adapter.validateWhatsAppTemplate!(second,"account_one","tr",{body:[],header:[]}),expectProvider("WHATSAPP_TEMPLATE_NOT_FOUND",false));
});

test("template request schema bounds names, languages, counts, length and control characters",()=>{
  const valid={template_name:"order_update",language_code:"tr",body_parameters:["Alper"],header_parameters:[],client_message_id:randomUUID()};
  assert.equal(whatsappTemplateSendSchema.safeParse(valid).success,true);
  assert.equal(whatsappTemplateSendSchema.safeParse({...valid,template_name:"Order Update"}).success,false);
  assert.equal(whatsappTemplateSendSchema.safeParse({...valid,language_code:"turkish"}).success,false);
  assert.equal(whatsappTemplateSendSchema.safeParse({...valid,body_parameters:Array(21).fill("x")}).success,false);
  assert.equal(whatsappTemplateSendSchema.safeParse({...valid,body_parameters:["x".repeat(1025)]}).success,false);
  assert.equal(whatsappTemplateSendSchema.safeParse({...valid,body_parameters:["x\nvalue"]}).success,false);
});

test("template API lists safely, allows a closed-window send through outbox, and is idempotent",async()=>{
  const {db,config}=testDatabase();
  const accountId=installAccount(db);
  db.prepare("UPDATE channel_accounts SET encrypted_credentials=? WHERE id=?").run(encryptSecret(credentials,config.encryptionKey),accountId);
  const inbound=ingestInbound(db,"META_WHATSAPP",normalizeWhatsAppWebhook(inboundPayload({timestamp:"1600000000"})).messages[0]);
  const providerCalls:Array<{method:string;url:string;body?:any}>=[];
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,now:()=>1_900_000_000_000,fetch:async(input,init)=>{
    const call={method:init?.method??"GET",url:String(input),body:init?.body?JSON.parse(String(init.body)):undefined};providerCalls.push(call);
    if(call.method==="GET")return response({data:[
      {id:"tmpl-1",name:"order_update",language:"tr",category:"UTILITY",status:"APPROVED",components:[{type:"BODY",text:"Merhaba {{1}}, sipariş {{2}}"}]},
      {id:"tmpl-2",name:"draft",language:"tr",category:"UTILITY",status:"PENDING",components:[]},
    ]});
    return response({messages:[{id:"wamid.template-api"}]});
  }});
  const registry=registryFor(adapter);const worker=new OutboxWorker(db,registry,config,"template-api-worker");
  const server=createApp({db,config,registry,worker,verify:async()=>admin}).listen(0);
  const address=server.address();if(!address||typeof address==="string")throw new Error("server");const base=`http://127.0.0.1:${address.port}`;
  const list=await fetch(`${base}/api/channels/${accountId}/whatsapp/templates`,{headers:{cookie:"test_session=x"}});
  assert.equal(list.status,200);const listed=await list.json() as any;
  assert.deepEqual(listed.items.map((item:any)=>item.status),["APPROVED","PENDING"]);assert.equal(listed.approved_count,1);
  assert.doesNotMatch(JSON.stringify(listed),/top-secret-token/);
  const clientId=randomUUID();const requestBody={template_name:"order_update",language_code:"tr",body_parameters:["Alper","12345"],header_parameters:[],client_message_id:clientId};
  const send=()=>fetch(`${base}/api/conversations/${inbound.conversationId}/whatsapp-template`,{method:"POST",headers:{"content-type":"application/json",cookie:"test_session=x",origin:config.appOrigin},body:JSON.stringify(requestBody)});
  const first=await send();assert.equal(first.status,202);const queued=await first.json() as any;assert.equal(queued.duplicate,false);
  const duplicate=await send();assert.equal(duplicate.status,202);assert.equal((await duplicate.json() as any).duplicate,true);
  const stored=db.prepare("SELECT body_text,message_type,status,metadata_json FROM messages WHERE id=?").get(queued.id) as any;
  assert.equal(stored.body_text,"[WhatsApp Template: order_update]");assert.equal(stored.message_type,"TEMPLATE");assert.equal(stored.status,"QUEUED");
  assert.equal(JSON.parse(stored.metadata_json).whatsapp_mode,"TEMPLATE");
  assert.equal((db.prepare("SELECT count(*) count FROM outbox_jobs WHERE message_id=?").get(queued.id) as any).count,1);
  await worker.tick();
  const sent=db.prepare("SELECT status,external_message_id FROM messages WHERE id=?").get(queued.id) as any;
  assert.deepEqual(sent,{status:"SENT",external_message_id:"wamid.template-api"});
  const post=providerCalls.find(call=>call.method==="POST")!;assert.equal(post.url,"https://graph.facebook.com/v23.0/phone-1/messages");
  assert.equal(post.body.to,"905551112233");assert.equal(post.body.type,"template");
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();
});

test("template outbox retries the same local message after a transient provider failure",async()=>{
  const {db,config}=testDatabase();const accountId=installAccount(db);
  db.prepare("UPDATE channel_accounts SET encrypted_credentials=? WHERE id=?").run(encryptSecret(credentials,config.encryptionKey),accountId);
  const inbound=ingestInbound(db,"META_WHATSAPP",normalizeWhatsAppWebhook(inboundPayload()).messages[0]);
  let calls=0;const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async()=>{calls+=1;if(calls===1)throw new Error("offline");return response({messages:[{id:"wamid.retry"}]});}});
  const registry=registryFor(adapter);const clientId=randomUUID();
  const queued=queueWhatsAppTemplate(db,registry,inbound.conversationId!,{templateName:"order_update",languageCode:"tr",bodyParameters:["Alper"],headerParameters:[],clientMessageId:clientId},admin);
  const worker=new OutboxWorker(db,registry,config,"template-retry-worker");await worker.tick();
  assert.equal((db.prepare("SELECT status FROM messages WHERE id=?").get(queued.id) as any).status,"QUEUED");
  db.prepare("UPDATE outbox_jobs SET next_attempt_at=CURRENT_TIMESTAMP WHERE message_id=?").run(queued.id);await worker.tick();
  assert.deepEqual(db.prepare("SELECT id,status,external_message_id FROM messages WHERE id=?").get(queued.id),{id:queued.id,status:"SENT",external_message_id:"wamid.retry"});
  assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE client_message_id=?").get(clientId) as any).count,1);
  db.close();
});

for (const [status,code,retryable] of [[400,"PROVIDER_VALIDATION_FAILED",false],[401,"AUTHENTICATION_FAILED",false],[403,"AUTHORIZATION_FAILED",false],[404,"RESOURCE_NOT_FOUND",false],[429,"RATE_LIMITED",true],[500,"PROVIDER_UNAVAILABLE",true]] as const) {
  test(`WhatsApp HTTP ${status} maps to ${code}`,async()=>{
    const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async()=>response({},status)});
    await assert.rejects(()=>adapter.sendMessage(envelope,account),expectProvider(code,retryable));
  });
}

test("network errors are retryable and never echo the access token",async()=>{
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,fetch:async()=>{throw new Error(`network ${credentials.access_token}`);}});
  await assert.rejects(()=>adapter.sendMessage(envelope,account),error=>{
    expectProvider("PROVIDER_UNAVAILABLE",true)(error);
    assert.doesNotMatch((error as Error).message,/top-secret-token/);
    return true;
  });
});

test("inbound text maps contact profile and provider-safe metadata",()=>{
  const batch=normalizeWhatsAppWebhook(inboundPayload());
  assert.equal(batch.messages.length,1);
  assert.deepEqual(batch.messages[0],{
    eventId:"whatsapp:phone-1:wamid.in-1",externalAccountId:"phone-1",externalConversationId:"905551112233",externalMessageId:"wamid.in-1",
    externalUserId:"905551112233",displayName:"Ayşe",body:"Siparişim nerede?",messageType:"TEXT",
    externalCreatedAt:"2023-11-14T22:13:20.000Z",
    metadata:{provider:"meta_whatsapp",wa_id:"905551112233",phone_number_id:"phone-1",message_type:"text"},
  });
});

test("inbound media is retained as a placeholder with media metadata",()=>{
  const message=normalizeWhatsAppWebhook(inboundPayload({type:"image"})).messages[0];
  assert.equal(message.body,"[Görsel]");
  assert.equal(message.messageType,"IMAGE");
  assert.equal(message.metadata.provider_media_id,"media-77");
  assert.equal(message.metadata.mime_type,"image/jpeg");
});

test("duplicate inbound ids are idempotent and phone number ids isolate accounts",()=>{
  const {db}=testDatabase();
  const firstAccount=installAccount(db);
  const secondAccount=randomUUID();
  db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,external_account_id) VALUES(?,'META_WHATSAPP','WhatsApp 2','ACTIVE','phone-2')").run(secondAccount);
  const first=normalizeWhatsAppWebhook(inboundPayload({id:"same-id",phone:"phone-1"})).messages[0];
  const second=normalizeWhatsAppWebhook(inboundPayload({id:"same-id",phone:"phone-2"})).messages[0];
  assert.equal(ingestInbound(db,"META_WHATSAPP",first).duplicate,false);
  assert.equal(ingestInbound(db,"META_WHATSAPP",first).duplicate,true);
  assert.equal(ingestInbound(db,"META_WHATSAPP",second).duplicate,false);
  assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE external_message_id='same-id'").get() as any).count,2);
  assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE channel_account_id=? AND external_message_id='same-id'").get(firstAccount) as any).count,1);
  assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE channel_account_id=? AND external_message_id='same-id'").get(secondAccount) as any).count,1);
  db.close();
});

test("status events progress SENT to DELIVERED to READ without downgrade",()=>{
  const {db}=testDatabase();
  const accountId=installAccount(db);
  const inbound=ingestInbound(db,"META_WHATSAPP",normalizeWhatsAppWebhook(inboundPayload()).messages[0]);
  const outboundId=randomUUID();
  db.prepare("INSERT INTO messages(id,conversation_id,channel_account_id,external_message_id,direction,sender_type,body_text,status) VALUES(?,?,?,'wamid.out-1','OUTBOUND','AGENT','Yanıt','SENT')")
    .run(outboundId,inbound.conversationId,accountId);
  for (const [status,expected,index] of [["sent","SENT",0],["delivered","DELIVERED",1],["read","READ",2]] as const) {
    const item=normalizeWhatsAppWebhook(statusPayload(status,"wamid.out-1","phone-1",String(1700000100+index))).statuses[0];
    applyMessageStatus(db,"META_WHATSAPP",item);
    assert.equal((db.prepare("SELECT status FROM messages WHERE id=?").get(outboundId) as any).status,expected);
  }
  applyMessageStatus(db,"META_WHATSAPP",normalizeWhatsAppWebhook(statusPayload("delivered","wamid.out-1","phone-1","1700000200")).statuses[0]);
  assert.equal((db.prepare("SELECT status FROM messages WHERE id=?").get(outboundId) as any).status,"READ");
  db.close();
});

test("failed status is idempotent and stores only safe provider error codes",()=>{
  const {db}=testDatabase();
  const accountId=installAccount(db);
  const inbound=ingestInbound(db,"META_WHATSAPP",normalizeWhatsAppWebhook(inboundPayload()).messages[0]);
  const outboundId=randomUUID();
  db.prepare("INSERT INTO messages(id,conversation_id,channel_account_id,external_message_id,direction,sender_type,body_text,status) VALUES(?,?,?,'wamid.failed','OUTBOUND','AGENT','Yanıt','SENT')")
    .run(outboundId,inbound.conversationId,accountId);
  const payload=statusPayload("failed","wamid.failed","phone-1","1700000200",[{code:131047,message:`do not store ${credentials.access_token}`}]);
  const item=normalizeWhatsAppWebhook(payload).statuses[0];
  applyMessageStatus(db,"META_WHATSAPP",item);
  applyMessageStatus(db,"META_WHATSAPP",item);
  const row=db.prepare("SELECT status,metadata_json FROM messages WHERE id=?").get(outboundId) as any;
  assert.equal(row.status,"FAILED");
  assert.deepEqual(JSON.parse(row.metadata_json).provider_error_codes,[131047]);
  assert.doesNotMatch(row.metadata_json,/top-secret-token/);
  db.close();
});

test("24-hour policy allows a recent inbound and rejects an expired window before queueing",()=>{
  const {db}=testDatabase();
  const accountId=installAccount(db);
  const now=1_800_000_000_000;
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,now:()=>now,fetch:async()=>response({messages:[{id:"x"}]})});
  const registry=registryFor(adapter);
  const recent=normalizeWhatsAppWebhook(inboundPayload({timestamp:String((now-60_000)/1000)}),now).messages[0];
  const ingested=ingestInbound(db,"META_WHATSAPP",recent);
  assert.doesNotThrow(()=>queueReply(db,registry,ingested.conversationId!,"Yanıt",randomUUID(),admin));
  db.prepare("UPDATE messages SET external_created_at=? WHERE channel_account_id=? AND direction='INBOUND'").run(new Date(now-SERVICE_WINDOW_FOR_TEST-1).toISOString(),accountId);
  assert.throws(()=>queueReply(db,registry,ingested.conversationId!,"Geç yanıt",randomUUID(),admin),expectProvider("WHATSAPP_TEMPLATE_REQUIRED",false));
  db.close();
});

const SERVICE_WINDOW_FOR_TEST=24*60*60*1000;

test("worker rechecks the service window and never calls Meta after it closes",async()=>{
  const {db,config}=testDatabase();
  const accountId=installAccount(db);
  let now=1_800_000_000_000;
  let calls=0;
  const adapter=new WhatsAppCloudAdapter({timeoutMs:100,now:()=>now,fetch:async()=>{calls+=1;return response({messages:[{id:"should-not-send"}]});}});
  const registry=registryFor(adapter);
  const inbound=ingestInbound(db,"META_WHATSAPP",normalizeWhatsAppWebhook(inboundPayload({timestamp:String((now-60_000)/1000)}),now).messages[0]);
  db.prepare("UPDATE channel_accounts SET encrypted_credentials=? WHERE id=?").run(encryptSecret(credentials,config.encryptionKey),accountId);
  const queued=queueReply(db,registry,inbound.conversationId!,"Yanıt",randomUUID(),admin);
  now+=SERVICE_WINDOW_FOR_TEST+1;
  await new OutboxWorker(db,registry,config,"whatsapp-window-worker").tick();
  assert.equal(calls,0);
  assert.equal((db.prepare("SELECT status FROM messages WHERE id=?").get(queued.id) as any).status,"FAILED");
  const job=db.prepare("SELECT status,last_error FROM outbox_jobs WHERE message_id=?").get(queued.id) as any;
  assert.equal(job.status,"FAILED");
  assert.match(job.last_error,/WHATSAPP_TEMPLATE_REQUIRED/);
  assert.doesNotMatch(job.last_error,/top-secret-token/);
  db.close();
});

test("Meta webhook keeps verification/signature behavior and persists WhatsApp payload once",async()=>{
  const {db,config}=testDatabase();
  installAccount(db);
  const registry=createAdapterRegistry(config);
  const worker=new OutboxWorker(db,registry,config);
  const server=createApp({db,config,registry,worker,verify:async()=>admin}).listen(0);
  const address=server.address();if(!address||typeof address==="string")throw new Error("server");
  const base=`http://127.0.0.1:${address.port}`;
  const challenge=await fetch(`${base}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=12345`);
  assert.equal(challenge.status,200);assert.equal(await challenge.text(),"12345");
  const denied=await fetch(`${base}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
  assert.equal(denied.status,403);
  const raw=JSON.stringify(inboundPayload({id:"webhook-message"}));
  const invalid=await fetch(`${base}/api/webhooks/meta`,{method:"POST",headers:{"content-type":"application/json","x-hub-signature-256":"sha256=bad"},body:raw});
  assert.equal(invalid.status,401);
  const signature=`sha256=${createHmac("sha256",config.metaAppSecret).update(raw).digest("hex")}`;
  for (let index=0;index<2;index+=1) {
    const result=await fetch(`${base}/api/webhooks/meta`,{method:"POST",headers:{"content-type":"application/json","x-hub-signature-256":signature},body:raw});
    assert.equal(result.status,200);
  }
  const row=db.prepare("SELECT m.body_text,m.metadata_json,ct.display_name FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE m.external_message_id='webhook-message'").get() as any;
  assert.equal(row.body_text,"Siparişim nerede?");
  assert.equal(row.display_name,"Ayşe");
  assert.equal(JSON.parse(row.metadata_json).phone_number_id,"phone-1");
  assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE external_message_id='webhook-message'").get() as any).count,1);
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();
});

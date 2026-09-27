import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {afterEach,test} from "node:test";
import type {Server} from "node:http";
import {createApp} from "../app.js";
import {createAdapterRegistry} from "./core/registry.js";
import {OutboxWorker} from "../outbox/worker.js";
import {decryptSecret,encryptSecret} from "../security/crypto.js";
import {testDatabase} from "../test-utils.js";
import type {PanelUser} from "../../shared/contracts/domain.js";

const admin:PanelUser={id:"admin",username:"admin",role:"admin",permissions:{"customer_hub:view":true,"customer_hub:manage_channels":true}};
const readonly:PanelUser={id:"reader",username:"reader",role:"readonly",permissions:{"customer_hub:view":true}};
const servers:Server[]=[];
afterEach(()=>{for(const server of servers.splice(0))server.close()});

function installTrendyol(db:ReturnType<typeof testDatabase>["db"],config:ReturnType<typeof testDatabase>["config"],sellerId:string,secrets:{api_key:string;api_secret:string}){
  const id=randomUUID();
  db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,encrypted_credentials,external_account_id,polling_interval_seconds) VALUES(?, 'TRENDYOL', ?, 'ACTIVE', ?, ?, 60)")
    .run(id,`Trendyol ${sellerId}`,encryptSecret({seller_id:sellerId,environment:"stage",...secrets},config.encryptionKey),sellerId);
  return id;
}

async function start(user:PanelUser){
  const state=testDatabase();
  const registry=createAdapterRegistry(state.config);
  const worker=new OutboxWorker(state.db,registry,state.config);
  const server=createApp({...state,registry,worker,verify:async()=>user}).listen(0);servers.push(server);
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("server");
  return {...state,base:`http://127.0.0.1:${address.port}`};
}

function request(base:string,url:string,init:RequestInit={}){return fetch(`${base}${url}`,{...init,headers:{cookie:"test_session=session",origin:"http://localhost:3100",...(init.body?{"content-type":"application/json"}:{}),...init.headers}})}

test("safe config never returns secrets and blank secret updates preserve the encrypted values",async()=>{
  const {db,config,base}=await start(admin);
  const id=installTrendyol(db,config,"seller-safe",{api_key:"top-secret-key",api_secret:"top-secret-value"});
  db.prepare("UPDATE channel_accounts SET last_error=? WHERE id=?").run("Provider rejected top-secret-value\nwith debug details",id);
  const list=await request(base,"/api/channels");
  assert.doesNotMatch(JSON.stringify(await list.json()),/top-secret-value/);
  const response=await request(base,`/api/channels/${id}/config`);
  assert.equal(response.status,200);
  const body=await response.json() as any;
  assert.deepEqual(body.non_secret_config,{seller_id:"seller-safe",environment:"stage"});
  assert.deepEqual(body.secret_state,{api_key:true,api_secret:true});
  assert.doesNotMatch(JSON.stringify(body),/top-secret/);
  assert.equal(response.headers.get("cache-control"),"no-store");

  const update=await request(base,`/api/channels/${id}`,{method:"PUT",body:JSON.stringify({id,channel_type:"TRENDYOL",name:"Güncel Trendyol",external_account_id:"seller-safe",credentials:{seller_id:"seller-safe",environment:"production",api_key:"   ",api_secret:""},polling_interval_seconds:120})});
  assert.equal(update.status,200,await update.text());
  const stored=db.prepare("SELECT encrypted_credentials,polling_interval_seconds FROM channel_accounts WHERE id=?").get(id) as any;
  assert.deepEqual(decryptSecret(stored.encrypted_credentials,config.encryptionKey),{seller_id:"seller-safe",environment:"production",api_key:"top-secret-key",api_secret:"top-secret-value"});
  assert.equal(stored.polling_interval_seconds,120);
  db.close();
});

test("secret rotation is isolated to the selected channel account and audit remains secret-free",async()=>{
  const {db,config,base}=await start(admin);
  const first=installTrendyol(db,config,"seller-one",{api_key:"first-key",api_secret:"first-old-secret"});
  const second=installTrendyol(db,config,"seller-two",{api_key:"second-key",api_secret:"second-secret"});
  const rotated="rotated-secret-value";
  const response=await request(base,`/api/channels/${first}`,{method:"PUT",body:JSON.stringify({id:first,channel_type:"TRENDYOL",name:"Birinci",credentials:{seller_id:"seller-one",environment:"stage",api_key:"",api_secret:rotated}})});
  assert.equal(response.status,200,await response.text());
  const firstRow=db.prepare("SELECT encrypted_credentials FROM channel_accounts WHERE id=?").get(first) as any;
  const secondRow=db.prepare("SELECT encrypted_credentials FROM channel_accounts WHERE id=?").get(second) as any;
  assert.deepEqual(decryptSecret(firstRow.encrypted_credentials,config.encryptionKey),{seller_id:"seller-one",environment:"stage",api_key:"first-key",api_secret:rotated});
  assert.deepEqual(decryptSecret(secondRow.encrypted_credentials,config.encryptionKey),{seller_id:"seller-two",environment:"stage",api_key:"second-key",api_secret:"second-secret"});
  const audit=db.prepare("SELECT payload_json FROM audit_logs WHERE action='CHANNEL_UPDATED' AND entity_id=? ORDER BY created_at DESC LIMIT 1").get(first) as any;
  assert.doesNotMatch(audit.payload_json,/rotated-secret-value|first-key|first-old-secret/);
  assert.deepEqual(JSON.parse(audit.payload_json).rotated_fields,["api_secret"]);
  db.close();
});

test("channel config mutations enforce permission and account identity",async()=>{
  const adminState=await start(admin);const id=installTrendyol(adminState.db,adminState.config,"seller-match",{api_key:"key",api_secret:"secret"});
  const mismatch=await request(adminState.base,`/api/channels/${id}`,{method:"PUT",body:JSON.stringify({id:randomUUID(),channel_type:"TRENDYOL",name:"Yanlış",credentials:{seller_id:"seller-match"}})});
  assert.equal(mismatch.status,409);
  const typeMismatch=await request(adminState.base,`/api/channels/${id}`,{method:"PUT",body:JSON.stringify({id,channel_type:"EMAIL",name:"Yanlış",credentials:{mailbox_email:"support@example.com"}})});
  assert.equal(typeMismatch.status,409);
  adminState.db.close();

  const readerState=await start(readonly);const readerId=installTrendyol(readerState.db,readerState.config,"seller-reader",{api_key:"key",api_secret:"secret"});
  assert.equal((await request(readerState.base,`/api/channels/${readerId}/config`)).status,200);
  const forbidden=await request(readerState.base,`/api/channels/${readerId}`,{method:"PUT",body:JSON.stringify({id:readerId,channel_type:"TRENDYOL",name:"Nope",credentials:{seller_id:"seller-reader"}})});
  assert.equal(forbidden.status,403);
  readerState.db.close();
});

test("email signature is account-scoped, returned as non-secret config and sanitized on update",async()=>{
  const {db,config,base}=await start(admin);const id=randomUUID();const credentials={mailbox_email:"support@example.test",imap_host:"imap.example.test",imap_port:"993",imap_secure:"true",smtp_host:"smtp.example.test",smtp_port:"465",smtp_secure:"true",username:"support@example.test",password:"app-password",from_address:"support@example.test",imap_mailbox:"INBOX"};
  db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,encrypted_credentials,external_account_id,polling_interval_seconds) VALUES(?,'EMAIL','Support','ACTIVE',?,'support@example.test',60)").run(id,encryptSecret(credentials,config.encryptionKey));
  const malicious='<table style="border-collapse:collapse"><tbody><tr><td><strong>DSDST</strong><img src="https://cdn.example.test/logo.png" onerror="steal()"><a href="javascript:steal()">bad</a><iframe src="https://evil.test"></iframe></td></tr></tbody></table>';
  const update=await request(base,`/api/channels/${id}`,{method:"PUT",body:JSON.stringify({id,channel_type:"EMAIL",name:"Support",credentials:{...credentials,password:"",signature_enabled:"true",signature_html:malicious},polling_interval_seconds:60})});assert.equal(update.status,200,await update.text());
  const response=await request(base,`/api/channels/${id}/config`);const body=await response.json()as any;assert.equal(body.non_secret_config.signature_enabled,"true");assert.match(body.non_secret_config.signature_html,/<table/);assert.match(body.non_secret_config.signature_html,/https:\/\/cdn\.example\.test\/logo\.png/);assert.doesNotMatch(body.non_secret_config.signature_html,/onerror|javascript:|iframe/i);assert.equal(body.secret_state.password,true);
  const stored=decryptSecret<Record<string,string>>((db.prepare("SELECT encrypted_credentials FROM channel_accounts WHERE id=?").get(id)as any).encrypted_credentials,config.encryptionKey);assert.equal(stored.signature_html,body.non_secret_config.signature_html);assert.equal(stored.password,"app-password");db.close();
});

test("attachment download serves only verified files inside the attachment root",async()=>{
  const {db,config,base}=await start(admin);
  const account=db.prepare("SELECT id FROM channel_accounts LIMIT 1").get() as {id:string};
  const contactId=randomUUID(),conversationId=randomUUID(),messageId=randomUUID(),safeId=randomUUID(),unsafeId=randomUUID();
  db.prepare("INSERT INTO contacts(id,display_name) VALUES(?,?)").run(contactId,"Dosya Testi");
  db.prepare("INSERT INTO conversations(id,channel_account_id,contact_id,external_conversation_id) VALUES(?,?,?,?)").run(conversationId,account.id,contactId,randomUUID());
  db.prepare("INSERT INTO messages(id,conversation_id,channel_account_id,direction,sender_type,status) VALUES(?,?,?,'INBOUND','CUSTOMER','RECEIVED')").run(messageId,conversationId,account.id);
  fs.mkdirSync(config.attachmentsDir,{recursive:true});const diskName=randomUUID();const contents=Buffer.from("safe attachment");fs.writeFileSync(path.join(config.attachmentsDir,diskName),contents);
  db.prepare("INSERT INTO attachments(id,message_id,type,filename,mime_type,size_bytes,storage_path,sha256) VALUES(?,?, 'DOCUMENT','report.pdf','application/pdf',?,?, ?)").run(safeId,messageId,contents.length,diskName,createHash("sha256").update(contents).digest("hex"));
  db.prepare("INSERT INTO attachments(id,message_id,type,filename,mime_type,size_bytes,storage_path,sha256) VALUES(?,?, 'DOCUMENT','unsafe.pdf','application/pdf',1,'../outside','hash')").run(unsafeId,messageId);
  const safe=await request(base,`/api/attachments/${safeId}/download`);assert.equal(safe.status,200);assert.equal(await safe.text(),contents.toString());assert.match(safe.headers.get("content-disposition")??"",/report.pdf/);
  const unsafe=await request(base,`/api/attachments/${unsafeId}/download`);assert.equal(unsafe.status,409);
  db.close();
});

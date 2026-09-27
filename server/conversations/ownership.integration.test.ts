import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type {PanelUser,ChannelType} from "../../shared/contracts/domain.js";
import {createApp} from "../app.js";
import {createAdapterRegistry} from "../channels/core/registry.js";
import {OutboxWorker} from "../outbox/worker.js";
import {testDatabase} from "../test-utils.js";

const permissions={"customer_hub:view":true,"customer_hub:reply":true,"customer_hub:assign":true,"customer_hub:manage_tags":true,"customer_hub:view_customer_context":true,"customer_hub:manage_channels":true};
const users:Record<string,PanelUser>={
  alper:{id:"alper",username:"Alper",role:"user",permissions},
  tayfun:{id:"tayfun",username:"Tayfun",role:"user",permissions},
  boss:{id:"boss",username:"Yönetici",role:"admin",permissions:{}},
};

test("personal email data is owner-only while shared channels remain collaborative",async()=>{
  const {db,config}=testDatabase();
  const registry=createAdapterRegistry(config),worker=new OutboxWorker(db,registry,config);
  const server=createApp({db,config,registry,worker,verify:async(_config,token)=>users[token]??Promise.reject(Object.assign(new Error("invalid"),{status:401}))}).listen(0);
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("server");
  const base=`http://127.0.0.1:${address.port}`;
  const request=(user:string,url:string,init:RequestInit={})=>fetch(`${base}${url}`,{...init,headers:{cookie:`test_session=${user}`,origin:config.appOrigin,...(init.body&&!(init.body instanceof FormData)?{"content-type":"application/json"}:{}),...init.headers}});
  const email=db.prepare("SELECT a.id account_id,c.id conversation_id,c.contact_id FROM channel_accounts a JOIN conversations c ON c.channel_account_id=a.id WHERE a.channel_type='EMAIL'").get() as {account_id:string;conversation_id:string;contact_id:string};
  db.prepare("UPDATE channel_accounts SET owner_user_id='alper' WHERE id=?").run(email.account_id);
  db.prepare("UPDATE conversations SET unread_count=9,assigned_user_id='tayfun',subject='PRIVATE-MAIL-ONLY',metadata_json=? WHERE id=?").run(JSON.stringify({reply_to:"private@example.test"}),email.conversation_id);
  db.prepare("UPDATE messages SET body_text='PRIVATE-SEARCH-TOKEN' WHERE conversation_id=?").run(email.conversation_id);

  const addSharedConversation=(type:ChannelType)=>{
    let account=db.prepare("SELECT id FROM channel_accounts WHERE channel_type=? LIMIT 1").get(type) as {id:string}|undefined;
    if(!account){account={id:randomUUID()};db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,external_account_id) VALUES(?,?,?,'ACTIVE',?)").run(account.id,type,type,`${type.toLowerCase()}-account`);}
    const contactId=randomUUID(),conversationId=randomUUID(),messageId=randomUUID(),now=new Date().toISOString();
    db.prepare("INSERT INTO contacts(id,display_name) VALUES(?,?)").run(contactId,`${type} Customer`);
    db.prepare("INSERT INTO conversations(id,channel_account_id,contact_id,external_conversation_id,status,last_message_at) VALUES(?,?,?,?, 'OPEN',?)").run(conversationId,account.id,contactId,`${type.toLowerCase()}-thread`,now);
    db.prepare("INSERT INTO messages(id,conversation_id,channel_account_id,external_message_id,direction,sender_type,body_text,status,external_created_at,received_at,created_at) VALUES(?,?,?,?, 'INBOUND','CUSTOMER',?,'RECEIVED',?,?,?)").run(messageId,conversationId,account.id,randomUUID(),`${type} inbound`,now,now,now);
    return conversationId;
  };
  const facebook=addSharedConversation("META_FACEBOOK");
  const whatsapp=addSharedConversation("META_WHATSAPP");
  void facebook;void whatsapp;

  const alperInbox=await request("alper","/api/conversations");
  const alperItems=(await alperInbox.json() as any).items as any[];
  assert.equal(alperInbox.status,200);
  assert.ok(alperItems.some(item=>item.id===email.conversation_id));
  const tayfunInbox=await request("tayfun","/api/conversations");
  const tayfunItems=(await tayfunInbox.json() as any).items as any[];
  assert.equal(tayfunInbox.status,200);
  assert.ok(!tayfunItems.some(item=>item.id===email.conversation_id));
  assert.ok(!tayfunItems.some(item=>item.channel_type==="EMAIL"));
  assert.ok(["TRENDYOL","META_WHATSAPP","META_INSTAGRAM","META_FACEBOOK","WEBSITE"].every(type=>tayfunItems.some(item=>item.channel_type===type)));
  assert.ok(["TRENDYOL","META_WHATSAPP","META_INSTAGRAM","META_FACEBOOK","WEBSITE"].every(type=>alperItems.some(item=>item.channel_type===type)));
  assert.equal(tayfunItems.reduce((sum,item)=>sum+item.unread_count,0),alperItems.reduce((sum,item)=>sum+item.unread_count,0)-9);
  const hiddenSearch=await request("tayfun","/api/conversations?q=PRIVATE-SEARCH-TOKEN");
  assert.deepEqual((await hiddenSearch.json() as any).items,[]);
  const ownerSearch=await request("alper","/api/conversations?q=PRIVATE-SEARCH-TOKEN");assert.equal(ownerSearch.status,200);assert.equal((await ownerSearch.json() as any).items[0].id,email.conversation_id);

  const tag=(db.prepare("SELECT id FROM tags LIMIT 1").get() as {id:string}).id;
  const hiddenOperations:Array<[string,string,string|undefined]>=[
    ["GET",`/api/conversations/${email.conversation_id}`,undefined],
    ["POST",`/api/conversations/${email.conversation_id}/replies`,JSON.stringify({body:"secret reply",client_message_id:randomUUID()})],
    ["POST",`/api/conversations/${email.conversation_id}/notes`,JSON.stringify({text:"secret note"})],
    ["PUT",`/api/conversations/${email.conversation_id}/assignment`,JSON.stringify({assigned_user_id:"tayfun"})],
    ["PUT",`/api/conversations/${email.conversation_id}/status`,JSON.stringify({status:"RESOLVED"})],
    ["PUT",`/api/conversations/${email.conversation_id}/tags/${tag}`,JSON.stringify({})],
    ["DELETE",`/api/conversations/${email.conversation_id}/tags/${tag}`,undefined],
    ["GET",`/api/conversations/${email.conversation_id}/customer-context`,undefined],
  ];
  for(const[method,url,body]of hiddenOperations){const response=await request("tayfun",url,{method,body});assert.equal(response.status,404,`${method} ${url}: ${await response.text()}`);}
  assert.equal((await request("alper",`/api/conversations/${email.conversation_id}`)).status,200);
  const sharedContact=(db.prepare("SELECT c.contact_id FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id WHERE a.channel_type='WEBSITE' LIMIT 1").get() as {contact_id:string}).contact_id;
  db.prepare("UPDATE contacts SET normalized_email='duplicate@example.test' WHERE id IN (?,?)").run(email.contact_id,sharedContact);
  const hiddenSuggestions=await request("tayfun","/api/contacts/suggestions");assert.ok(!(await hiddenSuggestions.json() as any).items.some((item:any)=>item.source_contact_id===email.contact_id||item.target_contact_id===email.contact_id));
  const ownerSuggestions=await request("alper","/api/contacts/suggestions");assert.ok((await ownerSuggestions.json() as any).items.some((item:any)=>item.source_contact_id===email.contact_id||item.target_contact_id===email.contact_id));
  const hiddenMerge=await request("tayfun","/api/contacts/merge",{method:"POST",body:JSON.stringify({source_contact_id:email.contact_id,target_contact_id:sharedContact})});assert.equal(hiddenMerge.status,404);

  const emailMessage=(db.prepare("SELECT id FROM messages WHERE conversation_id=? LIMIT 1").get(email.conversation_id) as {id:string}).id;
  fs.mkdirSync(config.attachmentsDir,{recursive:true});
  const storedName=randomUUID(),attachmentId=randomUUID(),attachmentBody=Buffer.from("private attachment");
  fs.writeFileSync(path.join(config.attachmentsDir,storedName),attachmentBody);
  db.prepare("INSERT INTO attachments(id,message_id,type,filename,mime_type,size_bytes,storage_path,sha256) VALUES(?,?,'DOCUMENT','private.pdf','application/pdf',?,?,?)").run(attachmentId,emailMessage,attachmentBody.length,storedName,createHash("sha256").update(attachmentBody).digest("hex"));
  assert.equal((await request("tayfun",`/api/attachments/${attachmentId}/download`)).status,404);
  assert.equal((await request("tayfun",`/api/attachments/messages/${emailMessage}`,{method:"POST"})).status,404);
  const ownerDownload=await request("alper",`/api/attachments/${attachmentId}/download`);assert.equal(ownerDownload.status,200);assert.equal(await ownerDownload.text(),attachmentBody.toString());

  const instagram=(db.prepare("SELECT c.id FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id WHERE a.channel_type='META_INSTAGRAM' LIMIT 1").get() as {id:string}).id;
  for(const user of ["alper","tayfun"]){const response=await request(user,`/api/conversations/${instagram}/replies`,{method:"POST",body:JSON.stringify({body:`${user} shared reply`,client_message_id:randomUUID()})});assert.equal(response.status,202,await response.text());}
  const outbound=db.prepare("SELECT body_text,metadata_json FROM messages WHERE conversation_id=? AND direction='OUTBOUND' ORDER BY rowid").all(instagram) as Array<{body_text:string;metadata_json:string}>;
  assert.deepEqual(outbound.map(row=>row.body_text),["alper shared reply","tayfun shared reply"]);
  assert.deepEqual(outbound.map(row=>JSON.parse(row.metadata_json)._hub_agent_username),["Alper","Tayfun"]);

  const tayfunChannels=await request("tayfun","/api/channels");
  assert.ok(!(await tayfunChannels.json() as any).items.some((item:any)=>item.id===email.account_id));
  assert.equal((await request("tayfun",`/api/channels/${email.account_id}/config`)).status,404);
  assert.equal((await request("boss",`/api/channels/${email.account_id}/config`)).status,404);
  assert.equal((await request("boss",`/api/channels/${email.account_id}/claim`,{method:"POST"})).status,404);
  const forged=await request("tayfun","/api/channels",{method:"POST",body:JSON.stringify({channel_type:"EMAIL",name:"Forged",external_account_id:"forged@example.test",owner_user_id:"alper",credentials:{}})});assert.equal(forged.status,400);
  const created=await request("tayfun","/api/channels",{method:"POST",body:JSON.stringify({channel_type:"EMAIL",name:"Tayfun Mail",external_account_id:"tayfun@example.test",credentials:{}})});assert.equal(created.status,201);const createdBody=await created.json() as any;assert.equal(createdBody.owner_user_id,"tayfun");assert.equal((db.prepare("SELECT owner_user_id FROM channel_accounts WHERE id=?").get(createdBody.id) as any).owner_user_id,"tayfun");

  const legacyId=randomUUID();db.prepare("INSERT INTO channel_accounts(id,channel_type,name,status,external_account_id,owner_user_id) VALUES(?,'EMAIL','Legacy','NOT_CONFIGURED','legacy@example.test',NULL)").run(legacyId);
  const legacyList=await request("boss","/api/channels");const legacyItem=(await legacyList.json() as any).items.find((item:any)=>item.id===legacyId);assert.equal(legacyItem.claimable,true);
  const claimed=await request("boss",`/api/channels/${legacyId}/claim`,{method:"POST"});assert.equal(claimed.status,200,await claimed.text());assert.equal((db.prepare("SELECT owner_user_id FROM channel_accounts WHERE id=?").get(legacyId) as any).owner_user_id,"boss");
  const claimAudit=db.prepare("SELECT actor_user_id,payload_json FROM audit_logs WHERE action='CHANNEL_OWNERSHIP_CLAIMED' AND entity_id=?").get(legacyId) as any;assert.equal(claimAudit.actor_user_id,"boss");assert.equal(JSON.parse(claimAudit.payload_json).owner_user_id,"boss");

  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();
});

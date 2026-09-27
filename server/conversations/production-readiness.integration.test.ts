import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import type {PanelUser} from "../../shared/contracts/domain.js";
import {createApp} from "../app.js";
import {createAdapterRegistry} from "../channels/core/registry.js";
import {ingestInbound} from "../messages/inbound.js";
import {OutboxWorker} from "../outbox/worker.js";
import {testDatabase} from "../test-utils.js";

const user:PanelUser={id:"alper",username:"Alper",role:"user",permissions:{"customer_hub:view":true,"customer_hub:reply":true,"customer_hub:assign":true,"customer_hub:manage_tags":true,"customer_hub:view_customer_context":true}};

async function harness(){
  const {db,config}=testDatabase();
  db.prepare("UPDATE channel_accounts SET owner_user_id=? WHERE channel_type='EMAIL'").run(user.id);
  const registry=createAdapterRegistry(config),worker=new OutboxWorker(db,registry,config);
  const server=createApp({db,config,registry,worker,verify:async()=>user}).listen(0);
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("server");
  const base=`http://127.0.0.1:${address.port}`;
  const request=(path:string,init:RequestInit={})=>fetch(`${base}${path}`,{...init,headers:{cookie:"test_session=alper",origin:config.appOrigin,...(init.body?{"content-type":"application/json"}:{}),...init.headers}});
  const close=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close()};
  return{db,request,close};
}

test("independent inbox counts do not change with status, channel, unread or tag list filters",async()=>{
  const {db,request,close}=await harness();
  try{
    const initial=await request("/api/conversations/counts");assert.equal(initial.status,200);const expected=await initial.json() as any;assert.equal(expected.all,4);assert.equal(expected.unread,3);assert.equal(expected.channels.EMAIL,1);
    const conversation=(db.prepare("SELECT id FROM conversations LIMIT 1").get() as {id:string}).id;const tag=(db.prepare("SELECT id FROM tags LIMIT 1").get() as {id:string}).id;db.prepare("INSERT INTO conversation_tags(conversation_id,tag_id) VALUES(?,?)").run(conversation,tag);
    for(const filter of ["status=WAITING_INTERNAL","status=RESOLVED","unread=true","channel=TRENDYOL",`tag=${tag}`]){
      const list=await request(`/api/conversations?${filter}`);assert.equal(list.status,200);
      const counts=await request("/api/conversations/counts");assert.deepEqual(await counts.json(),expected,filter);
    }
  }finally{await close()}
});

test("conversation detail is read-only and explicit read state survives refresh while new inbound becomes unread",async()=>{
  const {db,request,close}=await harness();
  try{
    const row=db.prepare("SELECT c.id,a.external_account_id,c.external_conversation_id,ci.external_user_id FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id JOIN contact_identities ci ON ci.contact_id=c.contact_id AND ci.channel_account_id=a.id WHERE a.channel_type='EMAIL'").get() as any;
    db.prepare("UPDATE conversations SET unread_count=2 WHERE id=?").run(row.id);
    assert.equal((await request(`/api/conversations/${row.id}`)).status,200);
    assert.equal((db.prepare("SELECT unread_count FROM conversations WHERE id=?").get(row.id) as any).unread_count,2,"GET must not mark read");
    const read=await request(`/api/conversations/${row.id}/read-state`,{method:"PUT",body:JSON.stringify({unread:false})});assert.equal(read.status,200);
    assert.equal((db.prepare("SELECT unread_count FROM conversations WHERE id=?").get(row.id) as any).unread_count,0);
    ingestInbound(db,"EMAIL",{eventId:"new-email",externalAccountId:row.external_account_id,externalConversationId:row.external_conversation_id,externalMessageId:"<new-email@example.test>",externalUserId:row.external_user_id,displayName:"Ali Vural",email:row.external_user_id,body:"Yeni mesaj",messageType:"EMAIL",externalCreatedAt:new Date().toISOString(),metadata:{message_id:"<new-email@example.test>"}});
    assert.equal((db.prepare("SELECT unread_count FROM conversations WHERE id=?").get(row.id) as any).unread_count,1);
    const unread=await request("/api/conversations?unread=true");assert.ok(((await unread.json()) as any).items.some((item:any)=>item.id===row.id));
    const before=(db.prepare("SELECT count(*) count FROM conversations").get() as any).count;
    const created=ingestInbound(db,"EMAIL",{eventId:"brand-new-email",externalAccountId:row.external_account_id,externalConversationId:"brand-new-thread",externalMessageId:"<brand-new@example.test>",externalUserId:"new-customer@example.test",displayName:"Yeni Müşteri",email:"new-customer@example.test",body:"İlk mesaj",messageType:"EMAIL",externalCreatedAt:new Date().toISOString(),metadata:{message_id:"<brand-new@example.test>"}});
    assert.ok(created.conversationId);assert.equal((db.prepare("SELECT unread_count FROM conversations WHERE id=?").get(created.conversationId) as any).unread_count,1);assert.equal((db.prepare("SELECT count(*) count FROM conversations").get() as any).count,before+1);
  }finally{await close()}
});

test("self assignment, internal notes, labels and customer notes persist through backend source of truth",async()=>{
  const {db,request,close}=await harness();
  try{
    const conversation=db.prepare("SELECT c.id,c.contact_id FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id WHERE a.channel_type='WEBSITE'").get() as {id:string;contact_id:string};
    const assign=await request(`/api/conversations/${conversation.id}/assignment`,{method:"PUT",body:JSON.stringify({assigned_user_id:user.id})});assert.equal(assign.status,200);
    assert.equal((db.prepare("SELECT assigned_user_id FROM conversations WHERE id=?").get(conversation.id) as any).assigned_user_id,user.id);
    assert.ok(((await (await request(`/api/conversations?assigned=${user.id}`)).json()) as any).items.some((item:any)=>item.id===conversation.id));
    const transfer=await request(`/api/conversations/${conversation.id}/assignment`,{method:"PUT",body:JSON.stringify({assigned_user_id:"tayfun"})});assert.equal(transfer.status,403);
    const unassign=await request(`/api/conversations/${conversation.id}/assignment`,{method:"PUT",body:JSON.stringify({assigned_user_id:null})});assert.equal(unassign.status,200);assert.equal((db.prepare("SELECT assigned_user_id FROM conversations WHERE id=?").get(conversation.id) as any).assigned_user_id,null);

    const messagesBefore=(db.prepare("SELECT count(*) count FROM messages WHERE conversation_id=?").get(conversation.id) as any).count;const jobsBefore=(db.prepare("SELECT count(*) count FROM outbox_jobs").get() as any).count;
    const note=await request(`/api/conversations/${conversation.id}/notes`,{method:"POST",body:JSON.stringify({text:"Yalnız ekip görür"})});assert.equal(note.status,201);assert.equal((db.prepare("SELECT count(*) count FROM internal_notes WHERE conversation_id=?").get(conversation.id) as any).count,1);assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE conversation_id=?").get(conversation.id) as any).count,messagesBefore);assert.equal((db.prepare("SELECT count(*) count FROM outbox_jobs").get() as any).count,jobsBefore);

    const tagIds=(db.prepare("SELECT id FROM tags ORDER BY name LIMIT 2").all() as Array<{id:string}>).map(row=>row.id);for(const tagId of tagIds)assert.equal((await request(`/api/conversations/${conversation.id}/tags/${tagId}`,{method:"PUT",body:"{}"})).status,200);
    const detail=await request(`/api/conversations/${conversation.id}`);assert.deepEqual(((await detail.json()) as any).tags.map((item:any)=>item.id).sort(),[...tagIds].sort());
    const filtered=await request(`/api/conversations?tag=${tagIds[0]}`);assert.ok(((await filtered.json()) as any).items.some((item:any)=>item.id===conversation.id));
    assert.equal((await request(`/api/conversations/${conversation.id}/tags/${tagIds[0]}`,{method:"DELETE"})).status,204);assert.equal((db.prepare("SELECT count(*) count FROM conversation_tags WHERE conversation_id=?").get(conversation.id) as any).count,1);

    const customerNote=await request(`/api/conversations/${conversation.id}/customer-notes`,{method:"POST",body:JSON.stringify({text:"Müşteri montaj desteği istiyor"})});assert.equal(customerNote.status,201);assert.equal((db.prepare("SELECT count(*) count FROM customer_notes WHERE contact_id=?").get(conversation.contact_id) as any).count,1);
    const account=(db.prepare("SELECT id FROM channel_accounts WHERE channel_type='MANUAL_EXTERNAL'").get() as {id:string}).id;const secondId=randomUUID();db.prepare("INSERT INTO conversations(id,channel_account_id,contact_id,external_conversation_id,status) VALUES(?,?,?,?,'OPEN')").run(secondId,account,conversation.contact_id,randomUUID());const notes=await request(`/api/conversations/${secondId}/customer-notes`);assert.equal(((await notes.json()) as any).items[0].text,"Müşteri montaj desteği istiyor");
  }finally{await close()}
});

test("unsupported n11 and manual replies are rejected before an outbox job is created",async()=>{
  const {db,request,close}=await harness();
  try{
    for(const channelType of ["N11","MANUAL_EXTERNAL"]){const account=(db.prepare("SELECT id FROM channel_accounts WHERE channel_type=?").get(channelType) as {id:string}).id;const contactId=randomUUID(),conversationId=randomUUID();db.prepare("INSERT INTO contacts(id,display_name) VALUES(?,?)").run(contactId,`${channelType} customer`);db.prepare("INSERT INTO conversations(id,channel_account_id,contact_id,external_conversation_id,status) VALUES(?,?,?,?,'OPEN')").run(conversationId,account,contactId,randomUUID());const response=await request(`/api/conversations/${conversationId}/replies`,{method:"POST",body:JSON.stringify({body:"fake send olmamalı",client_message_id:randomUUID()})});assert.equal(response.status,400,channelType);assert.equal(((await response.json()) as any).error.code,"CAPABILITY_UNSUPPORTED");}
    assert.equal((db.prepare("SELECT count(*) count FROM outbox_jobs").get() as any).count,0);
  }finally{await close()}
});

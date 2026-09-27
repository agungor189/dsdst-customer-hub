import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../../test-utils.js";
import { queueReply } from "../../outbox/service.js";
import { ProviderError } from "../core/types.js";
import { normalizeTrendyolQuestion, TrendyolAdapter, validateTrendyolAnswerText, type TrendyolQuestion } from "./adapter.js";

const credentials = {seller_id:"12345",api_key:"api-key",api_secret:"api-secret",environment:"stage"};
const answerEnvelope = {messageId:"message-1",externalConversationId:"question-9",body:"Bu yanıt yeterince uzundur.",metadata:{questionId:"question-9"}};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status,headers:{"content-type":"application/json"}});
}

function assertProviderError(error: unknown, code: string, retryable: boolean) {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.code,code);
  assert.equal(error.retryable,retryable);
  return true;
}

test("Trendyol request uses Basic auth, seller User-Agent and stage endpoint",async()=>{
  let request: {url:string;init?:RequestInit}|undefined;
  const adapter=new TrendyolAdapter({timeoutMs:100,fetch:async(input,init)=>{request={url:String(input),init};return jsonResponse({answerId:77});}});
  const result=await adapter.sendMessage(answerEnvelope,{id:"account",externalAccountId:"shop",credentials});
  assert.equal(result.externalMessageId,"77");
  assert.equal(result.status,"SENT");
  assert.match(request!.url,/^https:\/\/stageapigw\.trendyol\.com\/integration\/qna\/sellers\/12345\/questions\/question-9\/answers$/);
  const headers=new Headers(request!.init?.headers);
  assert.equal(headers.get("authorization"),`Basic ${Buffer.from("api-key:api-secret").toString("base64")}`);
  assert.equal(headers.get("user-agent"),"12345 - SelfIntegration");
  assert.deepEqual(JSON.parse(String(request!.init?.body)),{text:answerEnvelope.body});
});

test("question normalization maps product, customer and non-secret operational metadata",()=>{
  const normalized=normalizeTrendyolQuestion({id:41,text:"Ölçüsü nedir?",customerId:88,userName:"Ayşe",showUserName:true,status:"WAITING_FOR_ANSWER",creationDate:1_700_000_000_000,productName:"OYA Raf",productMainId:"OYA",barcode:"8690",imageUrl:"https://img.example/1",webUrl:"https://example/1"},"shop");
  assert.equal(normalized.externalConversationId,"41");
  assert.equal(normalized.externalMessageId,"trendyol-question-41");
  assert.equal(normalized.externalUserId,"88");
  assert.equal(normalized.displayName,"Ayşe");
  assert.equal(normalized.subject,"OYA Raf");
  assert.equal(normalized.messageType,"PRODUCT_QUESTION");
  assert.equal(normalized.metadata.barcode,"8690");
  assert.equal(normalized.metadata.productMainId,"OYA");
  assert.equal(normalized.externalCreatedAt,"2023-11-14T22:13:20.000Z");
  assert.equal(normalizeTrendyolQuestion({id:42,text:"?",showUserName:false},"shop",0).displayName,"Trendyol Müşterisi");
});

test("sync paginates from zero with bounded size and idempotently ingests question ids",async()=>{
  const {db}=testDatabase();
  const account=db.prepare("SELECT id,external_account_id FROM channel_accounts WHERE channel_type='TRENDYOL'").get() as {id:string;external_account_id:string};
  const pages:number[]=[];
  const questions:TrendyolQuestion[]=[
    {id:501,text:"İlk soru",customerId:1,creationDate:1_700_000_000_000,productName:"Ürün 1",status:"WAITING_FOR_ANSWER"},
    {id:502,text:"İkinci soru",customerId:2,creationDate:1_700_000_001_000,productName:"Ürün 2",status:"REPORTED"},
  ];
  const adapter=new TrendyolAdapter({timeoutMs:100,now:()=>1_700_100_000_000,fetch:async(input)=>{
    const url=new URL(String(input));
    const page=Number(url.searchParams.get("page"));pages.push(page);
    assert.equal(url.searchParams.get("size"),"50");
    assert.equal(url.searchParams.get("orderByField"),"LastModifiedDate");
    assert.equal(url.searchParams.get("orderByDirection"),"ASC");
    assert.ok(url.searchParams.has("startDate"));
    assert.ok(url.searchParams.has("endDate"));
    return jsonResponse({content:[questions[page]],page,size:50,totalPages:2,totalElements:2});
  }});
  const context={db,id:account.id,externalAccountId:account.external_account_id,credentials};
  await adapter.syncMessages(context);
  await adapter.syncMessages(context);
  assert.deepEqual(pages,[0,1,0,1]);
  assert.equal((db.prepare("SELECT count(*) count FROM messages WHERE channel_account_id=? AND external_message_id LIKE 'trendyol-question-%'").get(account.id) as any).count,2);
  assert.equal((db.prepare("SELECT count(*) count FROM conversations WHERE channel_account_id=? AND external_conversation_id IN ('501','502')").get(account.id) as any).count,2);
  assert.ok(db.prepare("SELECT cursor_value FROM sync_cursors WHERE channel_account_id=? AND cursor_type='trendyol_questions_last_modified_ms'").get(account.id));
  db.close();
});

test("ANSWERED provider response is synchronized once and deduplicates an outbox answerId",async()=>{
  const {db}=testDatabase();
  const account=db.prepare("SELECT id,external_account_id FROM channel_accounts WHERE channel_type='TRENDYOL'").get() as {id:string;external_account_id:string};
  const question={id:601,text:"Cevabı var mı?",customerId:3,creationDate:1_700_000_000_000,status:"ANSWERED",answer:{id:901,text:"Evet, ürün stoklarımızda bulunmaktadır.",creationDate:1_700_000_100_000}};
  const adapter=new TrendyolAdapter({timeoutMs:100,now:()=>1_700_200_000_000,fetch:async()=>jsonResponse({content:[question],page:0,size:50,totalPages:1})});
  const context={db,id:account.id,externalAccountId:account.external_account_id,credentials};
  await adapter.syncMessages(context);
  await adapter.syncMessages(context);
  const answers=db.prepare("SELECT direction,status,body_text FROM messages WHERE channel_account_id=? AND external_message_id='901'").all(account.id) as any[];
  assert.equal(answers.length,1);
  assert.deepEqual(answers[0],{direction:"OUTBOUND",status:"SENT",body_text:"Evet, ürün stoklarımızda bulunmaktadır."});
  db.close();
});

test("provider answer polling links a matching queued Hub reply instead of creating a duplicate",async()=>{
  const {db}=testDatabase();
  const account=db.prepare("SELECT id,external_account_id FROM channel_accounts WHERE channel_type='TRENDYOL'").get() as {id:string;external_account_id:string};
  const body="Evet, ürün stoklarımızda bulunmaktadır.";
  let answered=false;
  const adapter=new TrendyolAdapter({timeoutMs:100,now:()=>1_700_200_000_000,fetch:async()=>jsonResponse({content:[{
    id:602,text:"Cevabı var mı?",customerId:3,creationDate:1_700_000_000_000,status:answered?"ANSWERED":"WAITING_FOR_ANSWER",
    answer:answered?{id:902,text:body,creationDate:1_700_000_100_000}:null,
  }],page:0,size:50,totalPages:1})});
  const context={db,id:account.id,externalAccountId:account.external_account_id,credentials};
  await adapter.syncMessages(context);
  const conversation=(db.prepare("SELECT id FROM conversations WHERE channel_account_id=? AND external_conversation_id='602'").get(account.id) as {id:string}).id;
  const queued=queueReply(db,conversation,body,"26881391-16c8-4418-a21d-8a47ac8f615b",{id:"agent",username:"Agent",role:"admin",permissions:{}});
  answered=true;
  await adapter.syncMessages(context);
  const messages=db.prepare("SELECT id,external_message_id,status FROM messages WHERE conversation_id=? AND direction='OUTBOUND'").all(conversation) as any[];
  assert.deepEqual(messages,[{id:queued.id,external_message_id:"902",status:"SENT"}]);
  assert.equal((db.prepare("SELECT status FROM outbox_jobs WHERE message_id=?").get(queued.id) as any).status,"COMPLETED");
  db.close();
});

test("Trendyol answer validation rejects fewer than 10 and more than 2000 characters",async()=>{
  assert.throws(()=>validateTrendyolAnswerText("çok kısa"),error=>assertProviderError(error,"PROVIDER_VALIDATION_FAILED",false));
  assert.throws(()=>validateTrendyolAnswerText("x".repeat(2001)),error=>assertProviderError(error,"PROVIDER_VALIDATION_FAILED",false));
  let calls=0;
  const adapter=new TrendyolAdapter({timeoutMs:100,fetch:async()=>{calls+=1;return jsonResponse({answerId:1});}});
  await assert.rejects(()=>adapter.sendMessage({...answerEnvelope,body:"short"},{id:"a",externalAccountId:"s",credentials}),error=>assertProviderError(error,"PROVIDER_VALIDATION_FAILED",false));
  await assert.rejects(()=>adapter.sendMessage({...answerEnvelope,body:"x".repeat(2001)},{id:"a",externalAccountId:"s",credentials}),error=>assertProviderError(error,"PROVIDER_VALIDATION_FAILED",false));
  assert.equal(calls,0);
});

for (const [status,code,retryable] of [[401,"AUTHENTICATION_FAILED",false],[403,"AUTHORIZATION_FAILED",false],[404,"QUESTION_NOT_FOUND",false],[429,"RATE_LIMITED",true],[500,"PROVIDER_UNAVAILABLE",true]] as const) {
  test(`Trendyol HTTP ${status} maps to ${code}`,async()=>{
    const adapter=new TrendyolAdapter({timeoutMs:100,fetch:async()=>jsonResponse({},status)});
    await assert.rejects(()=>adapter.sendMessage(answerEnvelope,{id:"a",externalAccountId:"s",credentials}),error=>assertProviderError(error,code,retryable));
  });
}

test("network failures are retryable provider unavailable errors without credential leakage",async()=>{
  const adapter=new TrendyolAdapter({timeoutMs:100,fetch:async()=>{throw new Error(`request failed for ${credentials.api_secret}`);}});
  await assert.rejects(()=>adapter.sendMessage(answerEnvelope,{id:"a",externalAccountId:"s",credentials}),error=>{
    assertProviderError(error,"PROVIDER_UNAVAILABLE",true);
    assert.doesNotMatch((error as Error).message,/api-secret|api-key/);
    return true;
  });
});

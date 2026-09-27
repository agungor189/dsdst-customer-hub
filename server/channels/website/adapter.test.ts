import test from "node:test";
import assert from "node:assert/strict";
import { WebsiteAdapter, parseWebsiteCredentials } from "./adapter.js";

test("Website credentials require matching site id and exact non-wildcard origins",()=>{
  const adapter=new WebsiteAdapter();
  const valid={site_id:"dsdst-shopify-tr",site_name:"DSDST",allowed_origins:JSON.stringify(["https://dsdst.com","https://dsdst.myshopify.com"])};
  assert.deepEqual(adapter.validateConfiguration(valid,"dsdst-shopify-tr"),{valid:true,errors:[]});
  assert.equal(parseWebsiteCredentials(valid)?.allowed_origins.length,2);
  assert.equal(adapter.validateConfiguration({...valid,allowed_origins:"https://*.dsdst.com"},"dsdst-shopify-tr").valid,false);
  assert.equal(adapter.validateConfiguration(valid,"another-site").valid,false);
  assert.equal(adapter.validateConfiguration({...valid,widget_secret:"short"},"dsdst-shopify-tr").valid,false);
});

test("Website adapter persists first-party outbound delivery without a provider call",async()=>{
  const adapter=new WebsiteAdapter();
  const result=await adapter.sendMessage({messageId:"message-1",externalConversationId:"conversation-1",body:"Merhaba",metadata:{}},{id:"account",externalAccountId:"site",credentials:null});
  assert.deepEqual(result,{externalMessageId:"website-message-1",status:"SENT"});
});

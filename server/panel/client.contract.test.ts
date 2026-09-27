import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { getPanelCustomerContext, panelLogin, panelLogout, panelMe } from "./client.js";
import { testConfig } from "../test-utils.js";

const user = { id: "hub-user", username: "hub", role: "admin" as const, permissions: {} };

test("Customer Hub uses Panel scoped service auth and a service-bound human session", async () => {
  const requests: Array<{ path: string; apiKey?: string; authorization?: string }> = [];
  const panel = http.createServer((req, res) => {
    requests.push({ path: req.url || "", apiKey: req.headers["x-api-key"]?.toString(), authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/auth/service/login" && req.headers["x-api-key"] === "hub-service-key") {
      res.end(JSON.stringify({ success: true, token: "service-bound-session", user }));
      return;
    }
    if (req.url === "/api/auth/service/me" && req.headers["x-api-key"] === "hub-service-key"
      && req.headers.authorization === "Bearer service-bound-session") {
      res.end(JSON.stringify({ success: true, user }));
      return;
    }
    if (req.url === "/api/auth/service/logout" && req.headers["x-api-key"] === "hub-service-key"
      && req.headers.authorization === "Bearer service-bound-session") {
      res.end(JSON.stringify({ success: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "wrong contract" } }));
  });
  await new Promise<void>((resolve) => panel.listen(0, "127.0.0.1", resolve));
  const address = panel.address();
  assert.ok(address && typeof address !== "string");
  const config = testConfig({ panelBaseUrl: `http://127.0.0.1:${address.port}`, panelServiceApiKey: "hub-service-key", panelTimeoutMs: 2_000 } as any);
  try {
    const login = await panelLogin(config, "hub", "password");
    assert.equal(login.token, "service-bound-session");
    assert.deepEqual(await panelMe(config, login.token), user);
    await panelLogout(config, login.token);
    assert.deepEqual(requests.map(({ path }) => path), ["/api/auth/service/login", "/api/auth/service/me", "/api/auth/service/me", "/api/auth/service/logout"]);
    assert.ok(requests.every(({ apiKey }) => apiKey === "hub-service-key"));
  } finally {
    panel.closeAllConnections();
    await new Promise<void>((resolve) => panel.close(() => resolve()));
  }
});

test("customer context keeps Panel as order source of truth and forwards its real order fields",async()=>{
  let requested="";
  const payload={customer:{id:"customer-1",name:"Ada",email:"ada@example.test",phone:"+905551112233"},total_orders:1,total_sales:1250,orders:[{order_number:"DS-42",order_date:"2026-09-20T10:00:00.000Z",status:"SHIPPED",tracking_number:"TRACK-42",items:[{sku:"OYA-120",product_name:"OYA Raf",variant:"120 cm",quantity:2,amount:1250}]}]};
  const panel=http.createServer((req,res)=>{requested=req.url??"";res.setHeader("content-type","application/json");res.end(JSON.stringify(payload))});
  await new Promise<void>(resolve=>panel.listen(0,"127.0.0.1",resolve));const address=panel.address();assert.ok(address&&typeof address!=="string");
  const config=testConfig({panelBaseUrl:`http://127.0.0.1:${address.port}`} as any);
  try{const result=await getPanelCustomerContext(config,"human-session","customer-1",{email:"ada@example.test",phone:"+905551112233"});assert.deepEqual(result,{status:"ok",data:payload});assert.match(requested,/customer_id=customer-1/);assert.match(requested,/email=ada%40example.test/);assert.match(requested,/phone=%2B905551112233/)}finally{panel.closeAllConnections();await new Promise<void>(resolve=>panel.close(()=>resolve()))}
});

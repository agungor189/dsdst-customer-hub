import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { panelLogin, panelLogout, panelMe } from "./client.js";
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

import assert from "node:assert/strict";
import test from "node:test";
import { csrfOrigin } from "./middleware.js";
import { testConfig } from "../test-utils.js";

const invoke = (request: any) => {
  let status = 200;
  let body: any;
  let next = false;
  const response = { status(code: number) { status = code; return this; }, json(value: any) { body = value; return this; } } as any;
  csrfOrigin(testConfig({ appOrigin: "https://hub.example.test" }))
    (request, response, () => { next = true; });
  return { status, body, next };
};

test("Customer Hub unsafe browser requests require the exact configured Origin", () => {
  assert.equal(invoke({ method: "POST", path: "/api/conversations", headers: {} }).status, 403);
  assert.equal(invoke({ method: "POST", path: "/api/conversations", headers: { origin: "https://evil.example" } }).status, 403);
  assert.equal(invoke({ method: "POST", path: "/api/conversations", headers: { origin: "https://hub.example.test" } }).next, true);
  assert.equal(invoke({ method: "GET", path: "/api/conversations", headers: {} }).next, true);
  assert.equal(invoke({ method: "POST", path: "/api/webhooks/meta", headers: {} }).next, true,
    "signed provider webhooks are not browser-cookie CSRF surfaces");
  assert.equal(invoke({ method: "POST", path: "/api/webhooks/unsigned-future-provider", headers: {} }).status, 403,
    "future webhook routes must not inherit the signed Meta exemption");
});

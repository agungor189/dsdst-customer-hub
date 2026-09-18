import type { AppConfig } from "../config.js";
import type { PanelUser } from "../../shared/contracts/domain.js";

export class PanelUnavailableError extends Error {}

async function panelFetch(config: AppConfig, path: string, init: RequestInit) {
  try {
    return await fetch(`${config.panelBaseUrl}${path}`, { ...init, signal: AbortSignal.timeout(config.panelTimeoutMs) });
  } catch (error) {
    throw new PanelUnavailableError(error instanceof Error ? error.message : "Panel unavailable");
  }
}

export async function panelLogin(config: AppConfig, username: string, password: string): Promise<{token: string; user: PanelUser}> {
  const response = await panelFetch(config, "/api/auth/login", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({username,password}) });
  const body = await response.json() as any;
  if (!response.ok || !body.token) throw Object.assign(new Error(body?.error?.message ?? "Giriş başarısız"), { status: response.status });
  const user = await panelMe(config, body.token);
  return { token: body.token, user };
}

export async function panelMe(config: AppConfig, token: string): Promise<PanelUser> {
  const response = await panelFetch(config, "/api/auth/me", { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json() as any;
  if (!response.ok || !body.user) throw Object.assign(new Error(body?.error?.message ?? "Oturum geçersiz"), { status: response.status });
  return body.user;
}

export async function getPanelCustomerContext(config: AppConfig, token: string, panelCustomerId: string | null, query: {email?: string; phone?: string}) {
  if (!panelCustomerId && !query.email && !query.phone) return { status: "not_linked" as const };
  const params = new URLSearchParams();
  if (panelCustomerId) params.set("customer_id", panelCustomerId);
  if (query.email) params.set("email", query.email);
  if (query.phone) params.set("phone", query.phone);
  const response = await panelFetch(config, `/api/customer-hub/context?${params}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404) return { status: "not_linked" as const };
  if (!response.ok) throw new PanelUnavailableError(`Panel context ${response.status}`);
  return { status: "ok" as const, data: await response.json() };
}

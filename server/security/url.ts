import dns from "node:dns/promises";
import { isIP } from "node:net";

const privateIp = (ip: string) => {
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) return true;
  if (!isIP(ip)) return true;
  const parts = ip.split(".").map(Number);
  return isIP(ip) === 4 && (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
};

export async function assertSafeRemoteUrl(raw: string, allowlist: string[]) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Only HTTPS remote attachments are allowed");
  if (allowlist.length && !allowlist.includes(url.hostname.toLowerCase())) throw new Error("Remote host is not allowlisted");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(a => privateIp(a.address))) throw new Error("Private or unresolved remote address rejected");
  return url;
}

import type { IncomingHttpHeaders } from "node:http";

/** Writes must come from this page, not from another site in the same browser. The page may be served over
 * plain HTTP or behind an HTTPS proxy (Tailscale Serve), so compare hosts, not schemes; a proxy that rewrites
 * Host passes the original in X-Forwarded-Host. */
export function isSameOrigin(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    host = url.host.toLowerCase();
  } catch {
    return false;
  }
  const forwarded = String(headers["x-forwarded-host"] ?? "").split(",")[0]!.trim();
  return [headers.host, forwarded].some((h) => h && h.toLowerCase() === host);
}

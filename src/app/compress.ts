import { createHash } from "node:crypto";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";

const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|javascript))/;
const MIN_BYTES = 1024;

/**
 * Text responses (the app shell and report pages are ~320 KB each) go out gzipped, about a third of
 * the size over Tailscale, and pages that revalidate on every open get an ETag so an unchanged page
 * comes back as a 304. Every route answers with writeHead + end(body), so the headers are held until
 * end() and the body is compressed in one go.
 */
export function compressResponses(req: IncomingMessage, res: ServerResponse) {
  const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  let held: { status: number; headers: OutgoingHttpHeaders } | null = null;
  const writeHead = res.writeHead.bind(res) as (status: number, headers?: OutgoingHttpHeaders) => ServerResponse;
  const end = res.end.bind(res) as (body?: string | Buffer) => ServerResponse;

  res.writeHead = ((status: number, headers?: OutgoingHttpHeaders) => {
    held = { status, headers: { ...(headers ?? {}) } };
    return res;
  }) as ServerResponse["writeHead"];

  res.end = ((body?: unknown, ...rest: unknown[]) => {
    if (!held) return (end as (...args: unknown[]) => ServerResponse)(body, ...rest);
    const { status, headers } = held;
    held = null;
    const type = String(headers["content-type"] ?? "");
    const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.isBuffer(body) ? body : null;
    if (!bytes || status !== 200 || !COMPRESSIBLE.test(type)) {
      writeHead(status, headers);
      return bytes ? end(bytes) : end();
    }
    if (headers["cache-control"] === "no-cache" && !headers.etag) {
      const etag = `W/"${createHash("sha1").update(bytes).digest("base64url").slice(0, 22)}"`;
      headers.etag = etag;
      if (req.headers["if-none-match"] === etag) {
        delete headers["content-type"];
        writeHead(304, headers);
        return end();
      }
    }
    headers.vary = "accept-encoding";
    if (gzip && bytes.length >= MIN_BYTES) {
      writeHead(status, { ...headers, "content-encoding": "gzip" });
      return end(gzipSync(bytes));
    }
    writeHead(status, headers);
    return end(bytes);
  }) as ServerResponse["end"];
}

import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { compressResponses } from "../src/app/compress.js";

const page = "<!doctype html>" + "<p>Whim</p>".repeat(500);
let server: Server, port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    compressResponses(req, res);
    if (req.url === "/png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(Buffer.alloc(4096)); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
  request({ port, path, headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (c) => chunks.push(c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on("error", reject).end();
});

it("gzips text pages and answers an unchanged page with a 304", async () => {
  const first = await get("/", { "accept-encoding": "gzip, deflate, br" });
  expect(first.headers["content-encoding"]).toBe("gzip");
  expect(first.body.length).toBeLessThan(page.length / 5);
  expect(gunzipSync(first.body).toString()).toBe(page);
  const again = await get("/", { "accept-encoding": "gzip", "if-none-match": String(first.headers.etag) });
  expect([again.status, again.body.length]).toEqual([304, 0]);
  const plain = await get("/");
  expect(plain.headers["content-encoding"]).toBeUndefined();
  expect(plain.body.toString()).toBe(page);
});

it("leaves images alone", async () => {
  const png = await get("/png", { "accept-encoding": "gzip" });
  expect(png.headers["content-encoding"]).toBeUndefined();
  expect(png.body.length).toBe(4096);
});

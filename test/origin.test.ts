import { expect, it } from "vitest";
import { isSameOrigin } from "../src/app/origin.js";

it("accepts writes from the app's own page over HTTP or an HTTPS proxy, and refuses other sites", () => {
  expect(isSameOrigin({ host: "localhost:4310" })).toBe(true);
  expect(isSameOrigin({ host: "localhost:4310", origin: "http://localhost:4310" })).toBe(true);
  expect(isSameOrigin({ host: "100.79.230.77:4310", origin: "http://100.79.230.77:4310" })).toBe(true);
  expect(isSameOrigin({ host: "mac-mini.tail278e73.ts.net", origin: "https://mac-mini.tail278e73.ts.net" })).toBe(true);
  expect(isSameOrigin({ host: "127.0.0.1:4310", "x-forwarded-host": "mac-mini.tail278e73.ts.net", origin: "https://mac-mini.tail278e73.ts.net" })).toBe(true);
  expect(isSameOrigin({ host: "localhost:4310", origin: "https://evil.example" })).toBe(false);
  expect(isSameOrigin({ host: "localhost:4310", origin: "null" })).toBe(false);
});

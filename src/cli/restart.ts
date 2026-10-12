#!/usr/bin/env node
// Usage: npm run restart [-- --now]
// Restarts the app's launchd service (com.kvwong.whim, or WHIM_SERVICE) without cutting off a redesign, taste build
// or spot change: the app stops taking new jobs, this waits for the running ones to finish, then restarts.
// --now restarts straight away. Ctrl-C while waiting lets the app take jobs again and leaves it running.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const PORT = Number(process.env.PORT ?? 4310);
const API = `http://127.0.0.1:${PORT}/api/restart`;
const SERVICE = process.env.WHIM_SERVICE ?? "com.kvwong.whim";
const POLL_MS = 5000;

type Status = { pending: boolean; running: { kind: string; key: string; label: string }[] };

async function call(method: "GET" | "POST" | "DELETE"): Promise<Status> {
  const res = await fetch(API, { method });
  if (!res.ok) throw new Error(`${method} ${API}: ${res.status}`);
  return (await res.json()) as Status;
}

function restartService() {
  const target = `gui/${process.getuid?.() ?? 501}/${SERVICE}`;
  console.log(`Restarting ${target}`);
  execFileSync("launchctl", ["kickstart", "-k", target], { stdio: "inherit" });
}

async function main() {
  const { values } = parseArgs({ options: { now: { type: "boolean" } } });
  if (values.now) return restartService();

  let status: Status;
  try {
    status = await call("POST");
  } catch {
    console.log(`The app isn't answering on port ${PORT}, so there is nothing to wait for.`);
    return restartService();
  }
  process.once("SIGINT", () => {
    console.log("\nNot restarting. The app takes new jobs again.");
    call("DELETE").catch(() => {}).finally(() => process.exit(130));
  });

  let last = "";
  while (status.running.length) {
    const line = status.running.map((job) => `${job.kind} ${job.key}: ${job.label}`).join("; ");
    if (line !== last) console.log(`Waiting for ${status.running.length} job${status.running.length === 1 ? "" : "s"} to finish. ${line}`);
    last = line;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    // If the app went away meanwhile, there is nothing left to wait for.
    status = await call("GET").catch(() => ({ pending: true, running: [] }));
  }
  restartService();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

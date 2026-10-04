import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ImageInput } from "./providers.js";

const MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export const IMAGE_EXTENSIONS = new Set(Object.keys(MEDIA_TYPES));

export type LocalImage = ImageInput & {
  id: string;
  basename: string;
  absolutePath: string;
  /** Owner-provided room label, passed to inventory as a hint. */
  roomHint?: string | undefined;
};

/** Reads JPG/PNG/WebP files from a folder, drops exact duplicates, assigns stable ids. */
export async function loadImages(dir: string, limit: number, prefix = "img", only?: Set<string>): Promise<LocalImage[]> {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && MEDIA_TYPES[path.extname(entry.name).toLowerCase()])
    .map((entry) => entry.name)
    .filter((name) => !only || only.has(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const seen = new Set<string>();
  const images: LocalImage[] = [];
  for (const name of entries) {
    if (images.length >= limit) break;
    const absolutePath = path.join(dir, name);
    const bytes = await readFile(absolutePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    images.push({
      id: `${prefix}_${String(images.length + 1).padStart(2, "0")}`,
      basename: name,
      absolutePath,
      bytes,
      mediaType: MEDIA_TYPES[path.extname(name).toLowerCase()]!,
    });
  }
  return images;
}

export async function writeArtifact(dir: string, relative: string, data: string | Uint8Array): Promise<string> {
  const full = path.join(dir, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
  return full;
}

export async function writeJson(dir: string, relative: string, value: unknown): Promise<string> {
  return writeArtifact(dir, relative, `${JSON.stringify(value, null, 2)}\n`);
}

/** Promise.all with at most `limit` tasks in flight, preserving input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Per-run progress, in weighted work units. Retries add to the total rather than moving the bar backwards. */
export type Progress = { total: number; done: number; label: string; cancelled?: boolean };
export const progressContext = new AsyncLocalStorage<Progress>();

/** Per-run log sink. Each job runs inside its own context, so parallel runs keep separate logs. */
export const logContext = new AsyncLocalStorage<(message: string) => void>();

export function log(message: string): void {
  process.stderr.write(`[remodel-lens] ${message}\n`);
  logContext.getStore()?.(message);
  const p = progressContext.getStore();
  if (p) p.label = message; // show the step in flight, not just the last one finished
}


/** Cooperative cancellation: work in flight finishes, but no new step starts. */
export function isCancelled(): boolean {
  return !!progressContext.getStore()?.cancelled;
}

export class CancelledError extends Error {
  constructor() {
    super("Stopped before finishing.");
    this.name = "CancelledError";
  }
}

export function progressAdd(units: number): void {
  const p = progressContext.getStore();
  if (p) p.total += units;
}

export function progressDone(units: number, label?: string): void {
  const p = progressContext.getStore();
  if (!p) return;
  p.done = Math.min(p.total, p.done + Math.max(0, units));
  if (label) p.label = label;
}

/** A counting semaphore: at most `limit` callers inside `run` at once. */
export function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    // A released slot is handed straight to the next waiter, so newcomers can't jump the queue.
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(".runs/.image-cache");
const pending = new Map<string, Promise<Buffer>>();
const memory = new Map<string, Buffer>();
const MAX_MEMORY = 32 * 1024 * 1024;
let memoryBytes = 0;

/** Persistent derivatives, coalesced across simultaneous requests; bounded memory LRU. */
export async function cachedImage(key: string, build: () => Promise<Buffer>): Promise<Buffer> {
  const hot = memory.get(key);
  if (hot) { memory.delete(key); memory.set(key, hot); return hot; }
  const active = pending.get(key);
  if (active) return active;
  const operation = (async () => {
    const file = path.join(ROOT, createHash("sha256").update(key).digest("hex"));
    let bytes: Buffer;
    try { bytes = await readFile(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      bytes = await build();
      await mkdir(ROOT, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, file);
    }
    if (bytes.length <= MAX_MEMORY) {
      while (memoryBytes + bytes.length > MAX_MEMORY) {
        const oldest = memory.keys().next().value!;
        memoryBytes -= memory.get(oldest)!.length;
        memory.delete(oldest);
      }
      memory.set(key, bytes); memoryBytes += bytes.length;
    }
    return bytes;
  })();
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}

export async function imagePreview(file: string, requestedWidth: number) {
  const info = await stat(file);
  if (!info.isFile()) throw Object.assign(new Error("Not a file"), { code: "ENOENT" });
  // Limit derivative variants even when callers request arbitrary widths.
  const width = [160, 240, 480, 640, 960, 1280, 1600].find(w => w >= requestedWidth) ?? 1600;
  const version = createHash("sha256").update(`${file}:${info.size}:${info.mtimeMs}`).digest("hex").slice(0, 20);
  const key = `webp-v1:${version}:${width}`;
  return { version, width, bytes: await cachedImage(key, () => sharp(file).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer()) };
}

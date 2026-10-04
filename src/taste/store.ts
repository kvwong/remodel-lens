// Taste profiles on disk: profiles/<id>/{meta.json, brief.md, profile.json, profile.prev.json, references/}
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";

import { ROOT } from "../config.js";
import { IMAGE_EXTENSIONS, imageFingerprint, isNearDuplicate } from "../files.js";
import { renderProfileMarkdown } from "./pipeline.js";
import { TasteProfile } from "./schema.js";

export const PROFILES_DIR = path.join(ROOT, "profiles");
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_REF_EDGE = 2048;
export const MAX_REFERENCES = 40;

const Meta = z.object({
  name: z.string(),
  description: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastBuild: z
    .object({ at: z.string(), source: z.enum(["pipeline", "manual"]), signature: z.string(), imageCount: z.number() })
    .nullable()
    .default(null),
});
export type ProfileMeta = z.infer<typeof Meta>;

export type ProfileSummary = {
  id: string;
  name: string;
  built: boolean;
  referenceCount: number;
  ruleCount: number;
  stale: boolean;
  updatedAt: string;
};

export function profileDir(id: string): string {
  if (!ID_PATTERN.test(id)) throw Object.assign(new Error(`Invalid profile id "${id}".`), { status: 400 });
  return path.join(PROFILES_DIR, id);
}

/** The path stored in run.json and accepted by loadProfile. */
export function profileJsonPath(id: string): string {
  return path.relative(ROOT, path.join(profileDir(id), "profile.json"));
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "profile";
}

async function readMeta(id: string): Promise<ProfileMeta | null> {
  const file = path.join(profileDir(id), "meta.json");
  if (!existsSync(file)) return null;
  return Meta.parse(JSON.parse(await readFile(file, "utf8")));
}

async function writeMeta(id: string, meta: ProfileMeta): Promise<void> {
  await writeFile(path.join(profileDir(id), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

async function touch(id: string, patch: Partial<ProfileMeta> = {}): Promise<void> {
  const meta = await readMeta(id);
  if (!meta) throw Object.assign(new Error("Profile not found"), { status: 404 });
  await writeMeta(id, { ...meta, ...patch, updatedAt: new Date().toISOString() });
}

export async function listReferenceFiles(id: string): Promise<string[]> {
  const dir = path.join(profileDir(id), "references");
  if (!existsSync(dir)) return [];
  return (await readdir(dir))
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export async function readBrief(id: string): Promise<string> {
  const file = path.join(profileDir(id), "brief.md");
  return existsSync(file) ? readFile(file, "utf8") : "";
}

/** Fingerprint of what a build consumes (reference files + brief), to tell when rules are out of date. */
export async function inputSignature(id: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listReferenceFiles(id)) {
    const s = await stat(path.join(profileDir(id), "references", file));
    hash.update(`${file}:${s.size}\n`);
  }
  hash.update(await readBrief(id));
  return hash.digest("hex").slice(0, 16);
}

export async function readProfileJson(id: string): Promise<TasteProfile | null> {
  const file = path.join(profileDir(id), "profile.json");
  if (!existsSync(file)) return null;
  const raw = JSON.parse(await readFile(file, "utf8"));
  return { ...TasteProfile.parse(raw), imageCount: raw.imageCount } as TasteProfile;
}

export async function listTasteProfiles(): Promise<ProfileSummary[]> {
  if (!existsSync(PROFILES_DIR)) return [];
  const out: ProfileSummary[] = [];
  for (const entry of await readdir(PROFILES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
    const meta = await readMeta(entry.name).catch(() => null);
    if (!meta) continue;
    const profile = await readProfileJson(entry.name).catch(() => null);
    out.push({
      id: entry.name,
      name: meta.name,
      built: !!profile,
      referenceCount: (await listReferenceFiles(entry.name)).length,
      ruleCount: profile?.categories.reduce((n, c) => n + c.rules.length, 0) ?? 0,
      stale: !!meta.lastBuild && meta.lastBuild.signature !== (await inputSignature(entry.name)),
      updatedAt: meta.updatedAt,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createTasteProfile(name: string, fromId?: string | null, description = ""): Promise<string> {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw Object.assign(new Error("Give the profile a name."), { status: 400 });
  let id = slugify(clean);
  for (let n = 2; existsSync(profileDir(id)); n += 1) id = `${slugify(clean).slice(0, 36)}-${n}`;
  const dir = profileDir(id);
  await mkdir(path.join(dir, "references"), { recursive: true });
  const now = new Date().toISOString();
  let lastBuild: ProfileMeta["lastBuild"] = null;

  if (fromId) {
    const src = profileDir(fromId);
    if (!existsSync(src)) throw Object.assign(new Error("Profile to copy not found"), { status: 404 });
    for (const file of await listReferenceFiles(fromId)) await copyFile(path.join(src, "references", file), path.join(dir, "references", file));
    for (const file of ["brief.md", "profile.json", "profile.md"]) {
      if (existsSync(path.join(src, file))) await copyFile(path.join(src, file), path.join(dir, file));
    }
    // A copy starts in sync with its source's inputs, so it isn't flagged stale until something changes.
    const srcMeta = await readMeta(fromId);
    if (srcMeta?.lastBuild) lastBuild = { ...srcMeta.lastBuild, at: now };
  }
  await writeMeta(id, { name: clean, description: description.trim().slice(0, 300), createdAt: now, updatedAt: now, lastBuild });
  return id;
}

export async function renameTasteProfile(id: string, name: string, description?: string): Promise<void> {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw Object.assign(new Error("Give the profile a name."), { status: 400 });
  await touch(id, { name: clean, ...(description !== undefined ? { description: description.trim().slice(0, 300) } : {}) });
}

export async function saveBrief(id: string, text: string): Promise<void> {
  await writeFile(path.join(profileDir(id), "brief.md"), text.replace(/\r\n/g, "\n"));
  await touch(id);
}

/** Manual rule edits. The previous version is kept as profile.prev.json. */
export async function saveProfileJson(id: string, profile: TasteProfile, source: "pipeline" | "manual", signature?: string): Promise<void> {
  const dir = profileDir(id);
  const file = path.join(dir, "profile.json");
  if (existsSync(file)) await copyFile(file, path.join(dir, "profile.prev.json"));
  await writeFile(file, `${JSON.stringify(profile, null, 2)}\n`);
  await writeFile(path.join(dir, "profile.md"), renderProfileMarkdown(profile));
  const meta = await readMeta(id);
  await touch(id, {
    lastBuild:
      source === "pipeline"
        ? { at: new Date().toISOString(), source, signature: signature ?? (await inputSignature(id)), imageCount: profile.imageCount ?? 0 }
        : (meta?.lastBuild ?? null),
  });
}

export async function restorePreviousProfile(id: string): Promise<boolean> {
  const dir = profileDir(id);
  const prev = path.join(dir, "profile.prev.json");
  if (!existsSync(prev)) return false;
  const current = path.join(dir, "profile.json");
  const swap = path.join(dir, "profile.swap.json");
  if (existsSync(current)) await rename(current, swap);
  await rename(prev, current);
  if (existsSync(swap)) await rename(swap, prev);
  const profile = await readProfileJson(id);
  if (profile) await writeFile(path.join(dir, "profile.md"), renderProfileMarkdown(profile));
  await touch(id);
  return true;
}


/** Normalize an uploaded image into references/, refusing duplicates. Returns the stored file name. */
export async function addReference(id: string, bytes: Buffer): Promise<string> {
  const refsDir = path.join(profileDir(id), "references");
  await mkdir(refsDir, { recursive: true });
  const existing = await listReferenceFiles(id);
  if (existing.length >= MAX_REFERENCES) {
    throw Object.assign(new Error(`A profile can hold up to ${MAX_REFERENCES} references.`), { status: 400 });
  }
  let format: string | undefined;
  try {
    format = (await sharp(bytes).metadata()).format;
  } catch {
    throw Object.assign(new Error("That file isn't an image this app can read. Use JPG, PNG, WebP, or TIFF."), { status: 415 });
  }
  if (format === "heif") throw Object.assign(new Error("HEIC photos aren't supported. Export as JPG first."), { status: 415 });

  const print = await imageFingerprint(bytes);
  for (const file of existing) {
    if (isNearDuplicate(await imageFingerprint(path.join(refsDir, file)), print)) {
      throw Object.assign(new Error(`Already in this profile as ${file}.`), { status: 409 });
    }
  }
  const next = Math.max(0, ...existing.map((f) => Number(f.match(/(\d+)\.\w+$/)?.[1] ?? 0))) + 1;
  const file = `ref-${String(next).padStart(2, "0")}.jpg`;
  await sharp(bytes)
    .rotate()
    .resize({ width: MAX_REF_EDGE, height: MAX_REF_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#fff" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(path.join(refsDir, file));
  await touch(id);
  return file;
}

/** Soft delete into references/.removed so Undo can restore it. */
export async function removeReference(id: string, file: string): Promise<void> {
  const refsDir = path.join(profileDir(id), "references");
  const src = path.join(refsDir, path.basename(file));
  if (!existsSync(src)) throw Object.assign(new Error("Reference not found"), { status: 404 });
  await mkdir(path.join(refsDir, ".removed"), { recursive: true });
  await rename(src, path.join(refsDir, ".removed", path.basename(file)));
  await touch(id);
}

export async function restoreReference(id: string, file: string): Promise<void> {
  const refsDir = path.join(profileDir(id), "references");
  const src = path.join(refsDir, ".removed", path.basename(file));
  if (!existsSync(src)) throw Object.assign(new Error("Nothing to restore"), { status: 404 });
  await rename(src, path.join(refsDir, path.basename(file)));
  await touch(id);
}

export async function readTasteProfile(id: string) {
  const meta = await readMeta(id);
  if (!meta) return null;
  const signature = await inputSignature(id);
  return {
    id,
    meta,
    brief: await readBrief(id),
    profile: await readProfileJson(id),
    hasPrevious: existsSync(path.join(profileDir(id), "profile.prev.json")),
    references: await listReferenceFiles(id),
    signature,
    stale: !!meta.lastBuild && meta.lastBuild.signature !== signature,
  };
}

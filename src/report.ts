import { renderPageHeader } from "./detail-header.js";
import { motionScript } from "./motion.js";
import { planCost, type ChangePlan, type CostRange } from "./redesign/plan.js";
import { mobileTabsCss, mobileTabsHtml, mobileTabsScript } from "./ui/mobile-tabs.js";
import { appearanceScript, brandHead, brandLockup } from "./branding.js";
import type { PhotoResult, TierResult } from "./redesign/run.js";
import { TIER_LABELS, TIER_RANK, type Tier } from "./redesign/tiers.js";
import { ORIGINAL, pickKey, versionsFor, type Version, type VersionsFile } from "./redesign/versions.js";

/* ---------- Formatting ---------- */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1, trailingZeroDisplay: "stripIfInteger" });

/** "$850", "$12K", "$1.2M": rounded so ranges don't imply false precision. */
export function formatUSD(n: number): string {
  if (n < 1000) return usd.format(Math.round(n / 50) * 50);
  return usdCompact.format(n < 100_000 ? Math.round(n / 500) * 500 : Math.round(n / 5000) * 5000);
}

export function formatRange(r: CostRange): string {
  return `${formatUSD(r.low)}–${formatUSD(r.high)}`;
}

const esc = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Compact range for the eye, full figures for screen readers (aria-label is unreliable on plain text). */
function money(r: CostRange): string {
  return `<span aria-hidden="true">${formatRange(r)}</span><span class="sr-only">${usd.format(r.low)} to ${usd.format(r.high)}</span>`;
}

export const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const baseRoom = (room: string) => room.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
export const roomName = (p: PhotoResult) => sentence(p.room ?? p.inventory.roomType);
export const tierName = (t: Tier) => TIER_LABELS[t].name;

/**
 * Whole-listing estimate per tier. Photos of the same room ("great room", "great room (toward dining)")
 * describe one renovation, so each room counts once, at its higher estimate.
 */
export function listingTotals(photos: PhotoResult[]): Map<Tier, { range: CostRange; rooms: number }> {
  const byTier = new Map<Tier, Map<string, CostRange>>();
  for (const photo of photos) {
    const room = baseRoom(photo.room ?? photo.inventory.roomType);
    for (const t of photo.tiers) {
      const cost = planCost(t.plan);
      if (!cost) continue;
      const rooms = byTier.get(t.tier) ?? new Map<string, CostRange>();
      const prev = rooms.get(room);
      if (!prev || cost.high > prev.high) rooms.set(room, cost);
      byTier.set(t.tier, rooms);
    }
  }
  return new Map(
    [...byTier].map(([tier, rooms]) => [
      tier,
      { range: [...rooms.values()].reduce((a, r) => ({ low: a.low + r.low, high: a.high + r.high }), { low: 0, high: 0 }), rooms: rooms.size },
    ]),
  );
}

/* ---------- Status vocabulary ---------- */

export type Status = TierResult["status"];
export const STATUS: Record<Status, { label: string; meaning: string; icon: IconName }> = {
  verified: { label: "Verified", meaning: "Structure matches the listing", icon: "check" },
  review: { label: "Needs review", meaning: "Small drift. Check the notes", icon: "alert" },
  failed: { label: "Structure changed", meaning: "Inspiration only, not for decisions", icon: "x" },
  unchanged: { label: "No changes", meaning: "Already fits this scope", icon: "minus" },
  error: { label: "Not generated", meaning: "This image wasn't produced", icon: "x" },
};

/* ---------- Icons (one stroke family, drawn inline) ---------- */

const ICON_PATHS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  minus: '<path d="M5 12h14"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  pin: '<path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11Z"/><circle cx="12" cy="10" r="2.2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>',
} as const;
type IconName = keyof typeof ICON_PATHS;

function icon(name: IconName, cls = ""): string {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

function statusTag(status: Status, withMeaning = false): string {
  const s = STATUS[status];
  return `<span class="status s-${status}">${icon(s.icon)}<span>${s.label}</span>${withMeaning ? `<span class="status-meaning">${s.meaning}</span>` : ""}</span>`;
}

/* ---------- Plain-language verification notes ---------- */

const KIND: Record<string, string> = {
  window: "Window", exterior_door: "Exterior door", interior_door: "Door", doorway_opening: "Doorway",
  skylight: "Skylight", stair: "Stair", beam: "Beam", column: "Column", fireplace: "Fireplace",
};

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function plainReason(reason: string): string {
  const edge = reason.match(/^Edge structure shifted around (\w+) \((.*)\), r=(-?[\d.]+)$/s);
  if (edge) return `${KIND[edge[1]!] ?? sentence(edge[1]!.replace(/_/g, " "))} outline may have shifted (match ${edge[3]}): ${trim(edge[2]!, 110)}`;
  const plan = reason.match(/^Plan only partly followed \((\d+)\/10\)\.$/);
  if (plan) return `Only part of the plan shows in the image (${plan[1]}/10).`;
  const fixed: Record<string, string> = {
    "Openings were added, removed, or moved.": "A window or door opening was added, removed, or moved.",
    "Camera viewpoint changed.": "The camera angle changed, so this isn't a like-for-like view.",
    "Room size or ceiling height changed.": "The room size or ceiling height changed.",
  };
  if (fixed[reason]) return fixed[reason];
  // Judge notes: "<element> not preserved: <why>", where element may be an internal kind ("ceiling_line")
  // or "kind: description".
  const notKept = reason.match(/^(.*?) not preserved: (.*)$/s);
  if (notKept) {
    const element = notKept[1]!.replace(/^([a-z_]+)(?=:|$)/, (k) => KIND[k] ?? sentence(k.replace(/_/g, " "))).replace(/_/g, " ");
    return `${sentence(element)} changed: ${notKept[2]}`;
  }
  return reason;
}


/** Inspector code for spot changes; only included when the app serves the report. Runs inside the viewer's scope. */
const ITER_SCRIPT = String.raw`/* Change panel: a conversation per room and scope beside the image. Each reply is a new version, and a change starts from the version on screen. */
  const panel = dialog.querySelector(".iter");
  const log = panel.querySelector(".iter-log"), form = panel.querySelector(".iter-compose"), sub = panel.querySelector(".iter-sub");
  const pinsEl = form.querySelector(".iter-pins"), refsEl = form.querySelector(".iter-refs"), baseEl = form.querySelector(".iter-base"), statusLine = form.querySelector(".iter-status");
  const askEl = form.elements.ask, fileEl = form.querySelector('input[type="file"]');
  const pinTool = form.querySelector('[data-iter="pin"]'), sendBtn = form.querySelector(".isend");
  const vpins = stage.querySelector(".vpins");
  let file = ITER.file, ctx = null, viewed = "v1", pinMode = false, dirty = false, busy = false, polling = false;
  const drafts = {};
  const key = () => ctx.room + ":" + ctx.tier;
  const draft = () => (drafts[key()] ||= { pins: [], refs: [], ask: "" });
  const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const num = (id) => Number(String(id).slice(1)) || 0;
  const label = (id) => (id === "v1" ? "Original" : "Version " + num(id));
  const room = () => ITER.rooms[ctx.room];
  const original = () => room().tiers[ctx.tier];
  const versions = () => file.versions.filter((v) => v.photoId === ctx.room && v.tier === ctx.tier).sort((a, b) => num(a.id) - num(b.id));
  const entry = (id) => (id === "v1" ? Object.assign({ id: "v1" }, original()) : versions().find((v) => v.id === id));
  const usable = (id) => { const e = entry(id); return !!(e && e.image && e.status !== "running"); };
  const picked = () => { const id = file.picks[key()]; return id && usable(id) ? id : "v1"; };
  const base = () => (usable(viewed) ? viewed : picked());
  const statusHtml = (s) => (STATUS[s] ? '<span class="status s-' + s + '">' + STATUS[s].icon + "<span>" + STATUS[s].label + "</span></span>" : "");
  const RESULT = { done: "Done", partial: "Partly done", missed: "Missed" };

  async function call(method, path, body) {
    const res = await fetch(ITER.api + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong (" + res.status + ").");
    return data;
  }

  /* ---- Conversation ---- */
  function userMsg(v, prev) {
    const r = v.request;
    return '<div class="msg user">' +
      (v.parent !== prev ? '<p class="msg-from">From ' + label(v.parent).toLowerCase() + "</p>" : "") +
      (r.ask ? "<p>" + escHtml(r.ask) + "</p>" : "") +
      (r.pins.length ? '<ol class="msg-pins">' + r.pins.map((p, i) => '<li><span class="pin-n" aria-hidden="true">' + (i + 1) + "</span><span><strong>" + escHtml(cap(p.item || "Pinned spot")) + ":</strong> " + escHtml(p.note) + "</span></li>").join("") + "</ol>" : "") +
      (r.notes ? '<p class="msg-from">Context: ' + escHtml(r.notes) + "</p>" : "") +
      (r.references.length ? '<div class="msg-refs">' + r.references.map((src) => '<img src="' + escHtml(src) + '" alt="Reference photo">').join("") + "</div>" : "") +
      "</div>";
  }
  function botMsg(e) {
    if (e.status === "running") {
      const step = cap((e.progress?.label || "Starting…").replace(/^.*?:\s*/, ""));
      const pct = e.progress?.total ? Math.max(4, Math.round((e.progress.done / e.progress.total) * 100)) : 4;
      return '<div class="msg bot" data-id="' + e.id + '"><div class="msg-work"><span class="msg-step">' + escHtml(label(e.id)) + " · " + escHtml(step) + '</span><span class="msg-bar"><i style="width:' + pct + '%"></i></span></div></div>';
    }
    const v = e.id === "v1" ? null : e;
    const rationale = v ? v.plan?.rationale : e.rationale;
    const reasons = (e.reasons || []).filter(Boolean);
    const inUse = picked() === e.id;
    return '<div class="msg bot" data-id="' + e.id + '">' +
      (e.image ? '<button type="button" class="msg-shot" data-show="' + e.id + '" aria-pressed="' + (e.id === viewed) + '" aria-label="Show ' + label(e.id).toLowerCase() + '"><img src="' + escHtml(ITER.thumb + "/" + e.image + "?w=720") + '" alt="" loading="lazy"></button>' : "") +
      '<div class="msg-meta"><strong>' + label(e.id) + "</strong>" + statusHtml(e.status) + "</div>" +
      (rationale ? "<p>" + escHtml(rationale) + "</p>" : !v ? "<p>From the full run.</p>" : "") +
      (v && v.request.pins.some((p) => p.result) ? '<ol class="msg-pins">' + v.request.pins.map((p, i) => '<li><span class="pin-n" aria-hidden="true">' + (i + 1) + "</span><span>" + escHtml(p.resultNote || p.note) + '</span><span class="pin-result r-' + (p.result || "done") + '">' + (RESULT[p.result] || "") + "</span></li>").join("") + "</ol>" : "") +
      (e.status !== "verified" && reasons.length ? '<p class="msg-warn">' + escHtml(reasons[0]) + "</p>" : "") +
      '<div class="msg-actions">' +
        (e.image ? (inUse ? '<span class="in-report">' + STATUS.verified.icon.replace("<svg", '<svg aria-hidden="true"') + "In the report</span>" : '<button type="button" class="ibtn" data-use="' + e.id + '">Use in report</button>') : "") +
        (v ? '<button type="button" class="ibtn quiet" data-delete="' + e.id + '">Delete</button>' : "") +
      "</div></div>";
  }
  /* The dropdown beside the title: which version is on screen (and what the next change starts from). */
  const verMenu = dialog.querySelector(".viewer-ver");
  function renderVersionMenu() {
    const list = ctx ? versions() : [];
    verMenu.hidden = !list.length;
    if (!list.length) return;
    verMenu.innerHTML = ["v1", ...list.map((v) => v.id)].map((id) => '<option value="' + id + '"' + (usable(id) ? "" : " disabled") + ">Version " + num(id) + "</option>").join("");
    verMenu.value = viewed;
    placeVersionMenu();
  }
  verMenu.addEventListener("change", () => showOnStage(verMenu.value));
  function renderLog(toBottom) {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const list = versions();
    log.innerHTML = botMsg(entry("v1")) + list.map((v, i) => userMsg(v, i ? list[i - 1].id : "v1") + botMsg(v)).join("");
    renderVersionMenu();
    if (toBottom || near) log.scrollTop = log.scrollHeight;
  }
  function render() {
    const on = !!ctx;
    dialog.classList.toggle("iter-none", !on);
    log.hidden = form.hidden = !on;
    sub.textContent = on ? original().name + " · " + room().name : "";
    if (!on) { vpins.replaceChildren(); renderVersionMenu(); return; }
    renderLog(true);
    renderDraft();
  }

  /* ---- Composer ---- */
  function renderBase() {
    if (!ctx) return;
    baseEl.textContent = pinMode ? "Click the image to pin a note. Esc when done." : "";
  }
  function renderDraft() {
    const d = draft();
    askEl.value = d.ask;
    pinsEl.replaceChildren(...d.pins.map((pin, i) => {
      const li = document.createElement("li");
      li.innerHTML = '<span class="pin-n" aria-hidden="true"></span><span class="ipin-item"></span><input type="text" maxlength="500" placeholder="What should change here?"><button type="button" class="ibtn quiet" aria-label="Remove pin">✕</button>';
      li.querySelector(".pin-n").textContent = String(i + 1);
      li.querySelector(".ipin-item").textContent = pin.item + (pin.fixed ? " · stays as is at this scope, only its finish can change" : "");
      const input = li.querySelector("input");
      input.id = "iter-pin-" + i;
      input.value = pin.note;
      input.setAttribute("aria-label", "Note for pin " + (i + 1) + ", " + pin.item);
      input.addEventListener("input", () => { pin.note = input.value; });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); askEl.focus(); } });
      li.querySelector("button").addEventListener("click", () => { d.pins.splice(i, 1); renderDraft(); layoutPins(); });
      return li;
    }));
    refsEl.replaceChildren(...d.refs.map((src, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "iref";
      b.title = "Remove this reference photo";
      b.setAttribute("aria-label", "Remove reference photo " + (i + 1));
      b.innerHTML = '<img alt="">';
      b.querySelector("img").src = src;
      b.addEventListener("click", () => { d.refs.splice(i, 1); renderDraft(); });
      return b;
    }));
    fileEl.closest(".itool").hidden = d.refs.length >= 3;
    sendBtn.disabled = busy;
    renderBase();
  }
  function setPinMode(on) {
    pinMode = on && !!ctx;
    pinTool.setAttribute("aria-pressed", String(pinMode));
    stage.classList.toggle("pinning", pinMode);
    if (pinMode && stage.classList.contains("actual")) setZoom(false);
    renderBase();
    layoutPins();
  }

  /* ---- Pins on the image ---- */
  function snap(x, y) {
    const hit = room().boxes
      .filter((b) => x >= Math.min(b.box[0], b.box[2]) && x <= Math.max(b.box[0], b.box[2]) && y >= Math.min(b.box[1], b.box[3]) && y <= Math.max(b.box[1], b.box[3]))
      .sort((a, b) => Math.abs((a.box[2] - a.box[0]) * (a.box[3] - a.box[1])) - Math.abs((b.box[2] - b.box[0]) * (b.box[3] - b.box[1])))[0];
    if (hit) return { item: hit.item, fixed: hit.fixed };
    const row = y < 333 ? "Upper" : y < 667 ? "Middle" : "Lower", col = x < 333 ? "left" : x < 667 ? "center" : "right";
    return { item: row + " " + col + " of the image", fixed: false };
  }
  /** Keeps the version dropdown on the image's bottom-right corner, inside the visible part of the stage. */
  function placeVersionMenu() {
    if (verMenu.hidden || !img.isConnected) return;
    const right = Math.min(stage.clientWidth, img.offsetLeft - stage.scrollLeft + img.offsetWidth);
    const bottom = Math.min(stage.clientHeight, img.offsetTop - stage.scrollTop + img.offsetHeight);
    verMenu.style.left = stage.offsetLeft + right - verMenu.offsetWidth - 14 + "px";
    verMenu.style.top = stage.offsetTop + bottom - verMenu.offsetHeight - 14 + "px";
  }
  stage.addEventListener("scroll", placeVersionMenu, { passive: true });
  function layoutPins() {
    placeVersionMenu();
    vpins.replaceChildren();
    if (!ctx || !img.isConnected || !img.offsetWidth) return;
    const d = draft();
    const editing = pinMode || d.pins.length > 0;
    const pins = editing ? d.pins : (entry(viewed)?.request?.pins || []);
    pins.forEach((pin, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vpin" + (editing ? "" : " saved") + (pin.result && !editing ? " r-" + pin.result : "");
      b.textContent = String(i + 1);
      b.dataset.pin = String(i);
      b.style.left = img.offsetLeft + (pin.x / 1000) * img.offsetWidth + "px";
      b.style.top = img.offsetTop + (pin.y / 1000) * img.offsetHeight + "px";
      b.title = (pin.item ? pin.item + ": " : "") + (pin.note || "No note yet");
      b.setAttribute("aria-label", "Pin " + (i + 1) + ", " + b.title);
      if (!editing) b.tabIndex = -1;
      vpins.append(b);
    });
  }
  new ResizeObserver(() => layoutPins()).observe(img);
  img.addEventListener("load", () => layoutPins());
  vpins.addEventListener("click", (e) => {
    const pin = e.target.closest(".vpin:not(.saved)");
    if (pin) document.getElementById("iter-pin-" + pin.dataset.pin)?.focus();
  });
  iterPinClick = (e) => {
    if (!pinMode || !ctx || e.target !== img) return false;
    const d = draft();
    if (d.pins.length >= 8) { statusLine.textContent = "Up to 8 pins per change."; return true; }
    const r = img.getBoundingClientRect();
    const clamp = (n) => Math.max(0, Math.min(1000, Math.round(n)));
    const x = clamp(((e.clientX - r.left) / r.width) * 1000), y = clamp(((e.clientY - r.top) / r.height) * 1000);
    d.pins.push(Object.assign({ x, y, note: "" }, snap(x, y)));
    renderDraft();
    layoutPins();
    document.getElementById("iter-pin-" + (d.pins.length - 1))?.focus({ preventScroll: true });
    return true;
  };

  /* ---- What's on screen ---- */
  function showOnStage(id) {
    const e = entry(id);
    if (!e || !e.image || e.status === "running") return;
    viewed = id;
    if (!img.isConnected) stage.append(img);
    loadViewerImage(e.image, ITER.thumb + "/" + e.image + "?w=960");
    title.textContent = room().name + " · " + original().name;
    img.alt = title.textContent + (versions().length ? " · " + label(id) : "");
    renderVersionMenu();
    statusEl.innerHTML = STATUS[e.status] ? '<span class="status s-' + e.status + '">' + STATUS[e.status].icon + "<span>" + STATUS[e.status].label + '</span><span class="status-meaning">' + STATUS[e.status].meaning + "</span></span>" : "";
    log.querySelectorAll("[data-show]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.show === id)));
    renderBase();
    layoutPins();
  }
  iterShow = (item) => {
    const r = item.dataset.room, t = item.dataset.tier;
    if (ctx) draft().ask = askEl.value;
    ctx = r && t && ITER.rooms[r]?.tiers[t] ? { room: r, tier: t } : null;
    setPinMode(false);
    statusLine.textContent = "";
    render();
    if (ctx) {
      showOnStage(picked());
      requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    }
  };

  /* ---- Actions ---- */
  panel.addEventListener("click", async (e) => {
    const show = e.target.closest("[data-show]");
    if (show) return showOnStage(show.dataset.show);
    if (e.target.closest('[data-iter="pin"]')) { setPinMode(!pinMode); return; }
    const use = e.target.closest("[data-use]");
    if (use) {
      use.disabled = true;
      try { file = await call("PUT", "/picks", { photo: ctx.room, tier: ctx.tier, version: use.dataset.use }); dirty = true; renderLog(); }
      catch (err) { use.disabled = false; statusLine.textContent = err.message; }
      return;
    }
    const del = e.target.closest("[data-delete]");
    if (del) {
      if (!confirm("Delete " + label(del.dataset.delete).toLowerCase() + "? Its image and notes are removed from this report.")) return;
      del.disabled = true;
      try {
        file = await call("DELETE", "/versions/" + encodeURIComponent(ctx.room) + "/" + encodeURIComponent(ctx.tier) + "/" + encodeURIComponent(del.dataset.delete));
        dirty = true;
        renderLog();
        if (viewed === del.dataset.delete || !usable(viewed)) showOnStage(picked());
      } catch (err) { del.disabled = false; statusLine.textContent = err.message; }
    }
  });
  askEl.addEventListener("input", () => { if (ctx) draft().ask = askEl.value; });
  askEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  /** Downscales a reference photo before upload; the server shrinks it again. */
  async function shrink(f) {
    const bitmap = await createImageBitmap(f);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.86);
  }
  fileEl.addEventListener("change", async () => {
    const d = draft();
    for (const f of [...fileEl.files].slice(0, 3 - d.refs.length)) {
      try { d.refs.push(await shrink(f)); } catch {}
    }
    fileEl.value = "";
    renderDraft();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!ctx || busy) return;
    const d = draft();
    const ask = askEl.value.trim();
    const pins = d.pins.filter((p) => p.note.trim()).map((p) => ({ x: p.x, y: p.y, note: p.note.trim() }));
    statusLine.classList.remove("error");
    if (!ask && !pins.length) {
      statusLine.classList.add("error");
      statusLine.textContent = d.pins.length ? "Add a note to your pin, or describe the change." : "Describe a change, or pin a spot on the image.";
      return;
    }
    busy = true;
    sendBtn.disabled = true;
    statusLine.textContent = "";
    try {
      const res = await call("POST", "/versions", { photo: ctx.room, tier: ctx.tier, from: base(), ask, pins, references: d.refs });
      file = res.versions;
      dirty = true;
      drafts[key()] = { pins: [], refs: [], ask: "" };
      setPinMode(false);
      renderLog(true);
      renderDraft();
      layoutPins();
      poll();
    } catch (err) {
      statusLine.classList.add("error");
      statusLine.textContent = "Couldn't start the change: " + err.message;
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  });

  /* While a change is being made, follow its steps, then show the new version. */
  async function poll() {
    if (polling || !file.versions.some((v) => v.status === "running")) return;
    polling = true;
    while (file.versions.some((v) => v.status === "running")) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const before = new Set(file.versions.filter((v) => v.status === "running").map((v) => v.photoId + ":" + v.tier + ":" + v.id));
        file = await call("GET", "/versions");
        const done = file.versions.filter((v) => before.has(v.photoId + ":" + v.tier + ":" + v.id) && v.status !== "running");
        if (done.length) dirty = true;
        if (dialog.open && ctx) {
          renderLog();
          const mine = done.filter((v) => v.photoId === ctx.room && v.tier === ctx.tier && v.image).pop();
          if (mine) showOnStage(mine.id);
        }
      } catch {}
    }
    polling = false;
  }
  poll();

  const mobileIteration = matchMedia("(max-width: 860px), (hover: none) and (pointer: coarse) and (orientation: landscape) and (max-height: 600px)");
  mobileIteration.addEventListener("change", () => { if (mobileIteration.matches) setPanel(false); });
  /* Show or hide the panel. It starts hidden each time the viewer opens. */
  function setPanel(open) {
    open = open && !mobileIteration.matches;
    dialog.classList.toggle("iter-closed", !open);
    dialog.querySelectorAll('.viewer-iter').forEach((b) => b.setAttribute("aria-pressed", String(open)));
    if (!open) setPinMode(false);
    else requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  }
  dialog.addEventListener("click", (e) => {
    const t = e.target.closest('[data-viewer="changes"]');
    if (!t) return;
    setPanel(dialog.classList.contains("iter-closed"));
    if (!dialog.classList.contains("iter-closed")) askEl.focus({ preventScroll: true });
    else dialog.querySelector(".viewer-iter")?.focus({ preventScroll: true });
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open-change]");
    if (!b) return;
    b.closest(".shot")?.querySelector(".zoom")?.click();
    setPanel(true);
  });
  dialog.addEventListener("keydown", (e) => {
    if ((e.key === "c" || e.key === "C") && !dialog.classList.contains("iter-none") && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest?.("input, textarea, select")) {
      e.preventDefault();
      setPanel(dialog.classList.contains("iter-closed"));
    }
  });
  /* Room card dropdowns pick the version the report, totals, and PDFs use. */
  document.querySelectorAll("select[data-pick]").forEach((sel) => sel.addEventListener("change", async () => {
    sel.disabled = true;
    try {
      await call("PUT", "/picks", { photo: sel.dataset.room, tier: sel.dataset.tier, version: sel.value });
      reloadKeepingPlace();
    } catch (err) {
      sel.disabled = false;
      alert(err.message);
    }
  }));
  dialog.addEventListener("cancel", (e) => { if (pinMode) { e.preventDefault(); setPinMode(false); } });
  dialog.addEventListener("close", () => {
    setPinMode(false);
    if (dirty) reloadKeepingPlace();
  });

  /* After a change, the page reloads so cards, totals, and PDFs follow the picks; come back to the same place. */
  const STATE_KEY = "whim-report-state";
  function reloadKeepingPlace() {
    const tabs = {};
    document.querySelectorAll('.room [role="tab"][aria-selected="true"]').forEach((t) => { tabs[t.dataset.room] = t.dataset.tier; });
    try { sessionStorage.setItem(STATE_KEY, JSON.stringify({ path: location.pathname, y: scrollY, tabs })); } catch {}
    location.reload();
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
    sessionStorage.removeItem(STATE_KEY);
    if (saved && saved.path === location.pathname) {
      Object.entries(saved.tabs || {}).forEach(([r, t]) => selectTier(r, t, false));
      requestAnimationFrame(() => scrollTo(0, saved.y || 0));
    }
  } catch {}`;


/* ---------- Pieces ---------- */

/** App previews keep the same aspect ratio; full source remains the viewer target. */
export function previewAttributes(src: string, base?: string): string {
  if (!base) return `src="${esc(src)}"`;
  const url = `${base}/${src.split("/").map(encodeURIComponent).join("/")}`;
  return `src="${esc(url)}?w=960" srcset="${esc(url)}?w=480 480w, ${esc(url)}?w=960 960w, ${esc(url)}?w=1600 1600w" sizes="(max-width: 700px) 100vw, 50vw"`;
}

/** Clickable image that opens the viewer; every image of one room shares a group for ←/→ comparison. */
function renderZoomable(input: { previewBase?: string | undefined; src: string; alt: string; group: string; label: string; status?: Status; eager?: boolean; room?: string; tier?: Tier; version?: string; edit?: boolean }): string {
  const iter = input.room && input.tier ? ` data-room="${esc(input.room)}" data-tier="${input.tier}" data-version="${esc(input.version ?? ORIGINAL)}"` : "";
  return `<button class="zoom" type="button" data-group="${esc(input.group)}" data-src="${esc(input.src)}" data-label="${esc(input.label)}"${input.status ? ` data-status="${input.status}"` : ""}${iter} aria-label="${input.edit ? "Open and change" : "Enlarge"} ${esc(input.label)}">
      <img ${previewAttributes(input.src, input.previewBase)} alt="${esc(input.alt)}" loading="${input.eager ? "eager" : "lazy"}" decoding="async">
    </button>`;
}

function changeCost(c: ChangePlan["changes"][number] & { costBand?: string }): string {
  if (Number.isFinite(c.costLow) && Number.isFinite(c.costHigh)) {
    return money({ low: Math.min(c.costLow, c.costHigh), high: Math.max(c.costLow, c.costHigh) });
  }
  return esc(c.costBand ?? "–"); // results from before dollar ranges existed
}

export function fixedSummary(photo: PhotoResult): string {
  const counts = new Map<string, number>();
  for (const f of photo.inventory.fixed) {
    const k = (KIND[f.kind] ?? sentence(f.kind.replace(/_/g, " "))).toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${n} ${k.endsWith("s") ? k : `${k}s`}` : k)).join(", ");
}

function tierInfo(t: TierResult, changed?: Set<string>): string {
  const total = planCost(t.plan);
  const changes = t.plan.changes;
  const reasons = t.reasons.map(plainReason);
  const openings = t.edges.length
    ? `${t.edges.filter((e) => e.pass).length} of ${t.edges.length} window and door outlines match`
    : null;
  return `
    <div class="verdict">
      ${statusTag(t.status, true)}
      ${total ? `<span class="verdict-cost num">${money(total)}</span>` : ""}
    </div>
    ${reasons.length
      ? `<details class="fold"${t.status === "failed" || t.status === "error" ? " open" : ""}>
          <summary>What to check <span class="count">${reasons.length}</span></summary>
          <ul class="checks">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        </details>`
      : ""}
    ${changes.length
      ? `<details class="fold"${changed?.size ? " open" : ""}>
          <summary>Planned changes <span class="count">${changes.length}</span></summary>
          ${t.plan.expression || t.plan.architecturalLanguage
            ? `<p class="direction">${[t.plan.expression && sentence(t.plan.expression), t.plan.architecturalLanguage].filter(Boolean).map((x) => esc(x!)).join(" · ")}</p>`
            : ""}
          <ul class="changes">${changes.map((c) => `
            <li>
              <div class="change-head"><strong>${esc(sentence(c.element))}${changed?.has(c.element.toLowerCase()) ? '<span class="changed-tag">Changed</span>' : ""}</strong><span class="num">${changeCost(c)}</span></div>
              <p>${esc(c.proposed)}</p>
              <p class="was">Now: ${esc(c.current)}</p>
              ${c.costBasis ? `<p class="basis">${c.costSource === "estimate" ? "Model estimate, not from the cost table: " : ""}${esc(c.costBasis)}</p>` : ""}
            </li>`).join("")}
          </ul>
          ${t.plan.removedWalls.length ? `<h3 class="sub">Walls removed</h3><p>${esc(t.plan.removedWalls.join("; "))}</p>` : ""}
          ${t.plan.beyondScope?.length ? `<h3 class="sub">For the full look, beyond this scope</h3><ul class="plain">${t.plan.beyondScope.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
          ${t.plan.feasibilityFlags.length ? `<h3 class="sub">Check with a contractor</h3><ul class="plain">${t.plan.feasibilityFlags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
          ${openings || t.judgement
            ? `<p class="fine">${[openings, t.judgement ? `plan followed ${t.judgement.planAdherence}/10` : null, t.attempts > 1 ? `${t.attempts} attempts` : null].filter(Boolean).join(" · ")}</p>`
            : ""}
        </details>`
      : ""}`;
}

export function pickFeature(photos: PhotoResult[]): PhotoResult | null {
  const weight = { verified: 3, review: 2, unchanged: 1, failed: 0, error: 0 } as const;
  const score = (p: PhotoResult) => p.tiers.reduce((s, t) => s + (t.image ? 1 : 0) + weight[t.status], 0);
  const maxCost = (p: PhotoResult) => Math.max(0, ...p.tiers.map((t) => planCost(t.plan)?.high ?? 0));
  return [...photos].sort((a, b) => score(b) - score(a) || maxCost(b) - maxCost(a))[0] ?? null;
}

const usable = (t: TierResult | undefined): t is TierResult & { image: string } => !!t?.image && (t.status === "verified" || t.status === "review");

/** The redesign to put next to a listing photo: the preferred scope if it's trustworthy, else the most ambitious trustworthy one. */
export function showcase(photo: PhotoResult, preferred: Tier | null): TierResult | null {
  const pref = photo.tiers.find((t) => t.tier === preferred);
  if (usable(pref)) return pref;
  const ranked = [...photo.tiers].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
  return ranked.find(usable) ?? ranked.find((t) => !!t.image) ?? null;
}

/** The biggest single changes in one scope, one entry per room and element (rooms shot twice count once). */
export function largestCosts(photos: PhotoResult[], tier: Tier, limit = 4): Array<{ room: string; c: ChangePlan["changes"][number] }> {
  return photos
    .flatMap((p) => (p.tiers.find((t) => t.tier === tier)?.plan.changes ?? []).map((c) => ({ room: roomName(p), c })))
    .filter(({ c }) => Number.isFinite(c.costHigh))
    .sort((a, b) => b.c.costHigh - a.c.costHigh)
    .filter((d, i, all) => all.findIndex((e) => baseRoom(e.room) === baseRoom(d.room) && e.c.element === d.c.element) === i)
    .slice(0, limit);
}

/* ---------- Page ---------- */

export function renderReport(input: {
  title: string;
  previewBase?: string;
  photos: PhotoResult[];
  profileSummary: string;
  location?: string | null;
  /** Link back to the listing in the picker; omitted for static reports opened from disk. */
  backHref?: string | null;
  run?: { startedAt: string; profileName?: string | null; stopped?: boolean };
  /** Dedicated scope album served by the app. */
  redesignScope?: Tier | null;
  /** PDF download links; only the app can build PDFs, so static reports omit them. */
  pdf?: { summary: string; full: string } | null;
  /** Shareable single-file HTML download links, served by the app like the PDFs. */
  html?: { summary: string; full: string } | null;
  /** Renders the page as a shared copy: "summary" shows one redesign per room with its costs, "full" is the whole report. */
  share?: "summary" | "full" | null;
  /** Spot changes; only the app can make them, so static reports omit this. `photos` already has each room's pick applied. */
  changes?: { api: string; originals: PhotoResult[]; versions: VersionsFile } | null;
}): string {
  const zoomable = (shot: Parameters<typeof renderZoomable>[0]) => renderZoomable({ ...shot, previewBase: input.previewBase });
  const photos = input.photos;
  const tiers = [...new Set(photos.flatMap((p) => p.tiers.map((t) => t.tier)))].sort((a, b) => TIER_RANK[a] - TIER_RANK[b]);
  const totals = listingTotals(photos);
  const feature = pickFeature(photos);
  const started = input.run ? new Date(input.run.startedAt) : null;
  const dateText = started ? new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" }).format(started) : null;
  const reportName = input.run?.profileName?.trim() || input.title;
  const displayTitle = input.redesignScope ? `${reportName} · ${tierName(input.redesignScope)} redesign` : reportName;
  const meta = [
    input.redesignScope ? TIER_LABELS[input.redesignScope].blurb : tiers.map(tierName).join(" + "),
    `${photos.length} ${photos.length === 1 ? "photo" : "photos"}`,
    started ? new Intl.DateTimeFormat("en-US", {month:"short",day:"numeric",year:"numeric"}).format(started) : null,
    input.share === "summary" ? "Summary" : input.share === "full" ? "Full scope" : null,
  ].filter(Boolean) as string[];
  const summary = input.share === "summary";
  const preferred = feature ? showcase(feature, null)?.tier ?? null : null;
  const back = input.backHref ? { href: esc(input.backHref), label: `Back to ${esc(input.title)}` } : null;
  const docTitle = `${displayTitle}${started ? ` · ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(started)}` : ""} · Whim`;

  const tally = (tier: Tier) => {
    const list = photos.map((p) => p.tiers.find((t) => t.tier === tier)).filter((t): t is TierResult => !!t);
    const n = (s: Status) => list.filter((t) => t.status === s).length;
    return { total: list.length, verified: n("verified"), review: n("review"), failed: n("failed") + n("error") };
  };

  const overview = tiers.length && !input.share ? `
  <section class="overview card" aria-label="Redesigns">
    ${input.redesignScope ? "" : `<h2 id="overview-h">Redesigns</h2>`}
    <div class="scope-albums" style="--cols:${input.redesignScope ? 1 : tiers.length}">
    ${(input.redesignScope ? tiers.filter(t => t === input.redesignScope) : tiers).map((tier) => {
      const results = photos.flatMap(p => { const t = p.tiers.find(t => t.tier === tier); return t?.image ? [{ p, t }] : []; });
      const x = totals.get(tier), c = tally(tier);
      const direction = input.profileSummary.trim().split(/\s+/).slice(0, 45).join(" ").replace(/[,:;]$/, "");
      const concept = { cosmetic: "A coordinated refresh through paint, lighting, and furniture, retaining the existing layout and permanent finishes.", moderate: "A cohesive material refresh through cabinetry, counters, floors, and trim, retaining the existing room layout.", major: "A broader architectural reimagining of the rooms, combining material changes with proposed changes to walls, openings, and ceilings." }[tier];
      const selected = input.redesignScope === tier;
      return `<section class="scope-album ${selected ? 'redesign-page' : 'scope-link'}">
        ${selected ? `<div class="album-facts"><div>${x ? `<span class="plate-total num">${money(x.range)}</span>` : ""}<p class="plate-sub">${results.length} photos · ${x?.rooms ?? results.length} rooms${dateText ? ` · ${esc(dateText)}` : ""}</p></div><details class="album-summary"><summary>Design concept</summary><p>${esc(concept)} ${esc(direction)}${direction && !/[.!?]$/.test(direction) ? "." : ""}</p></details></div>` : `<div class="album-cover"><a class="album-pile" href="?scope=${tier}" aria-label="View ${tierName(tier)} redesign">${results.slice(0, 4).map(({p,t}, i) => `<img ${previewAttributes(t.image!, input.previewBase)} alt="${esc(tierName(tier) + ' redesign of ' + roomName(p))}" style="--i:${i}" loading="lazy">`).join("")}</a>
        <span class="album-copy"><span class="plate-title">${tierName(tier)}</span><span class="plate-sub">${TIER_LABELS[tier].blurb} · ${results.length} photos</span>
        ${x ? `<span class="plate-total num">${money(x.range)}</span>` : ""}
        <a class="album-open" href="?scope=${tier}">View redesign</a></span></div>`}
        ${selected ? `<div class="album-grid">${results.map(({p,t}) => `<figure>
          <span hidden>${zoomable({src:p.original,alt:roomName(p),group:`album-${tier}-${p.id}`,label:`${roomName(p)} · Listing photo`})}</span>
          ${zoomable({src:t.image!,alt:`${tierName(tier)} redesign of ${roomName(p)}`,group:`album-${tier}-${p.id}`,label:`${roomName(p)} · ${tierName(tier)}`,status:t.status,...(input.changes ? {room:p.id,tier,version:input.changes.versions.picks[pickKey(p.id,tier)] ?? ORIGINAL} : {})})}
          <figcaption>${esc(roomName(p))}</figcaption></figure>`).join("")}</div>
        ` : ""}
      </section>`;
    }).join("")}</div>
  </section>` : "";

  const table = `
  <section class="by-room card" aria-labelledby="byroom-h">
    <details class="fold section-fold">
    <summary><h2 id="byroom-h">By room</h2><span class="fold-meta num">${photos.length} photos · Costs and verification by scope</span></summary>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="byroom-h">
      <table>
        <thead><tr><th scope="col">Room</th>${tiers.map((t) => `<th scope="col">${tierName(t)}</th>`).join("")}</tr></thead>
        <tbody>${photos.map((p) => `
          <tr>
            <th scope="row"><a class="room-link" href="#${p.id}"><img class="room-thumb" src="${esc(input.previewBase ? `${input.previewBase}/${p.original.split("/").map(encodeURIComponent).join("/")}?w=160` : p.original)}" alt="" width="64" height="48" loading="lazy" decoding="async"><span>${esc(roomName(p))}</span></a></th>
            ${tiers.map((tier) => {
              const t = p.tiers.find((x) => x.tier === tier);
              const cost = t ? planCost(t.plan) : null;
              return `<td>${t ? statusTag(t.status) : "–"}${cost ? `<div class="cell-cost num">${money(cost)}</div>` : ""}</td>`;
            }).join("")}
          </tr>`).join("")}
        </tbody>
        ${totals.size
          ? `<tfoot><tr><th scope="row">Whole listing</th>${tiers.map((t) => { const x = totals.get(t); return `<td class="num">${x ? money(x.range) : "–"}</td>`; }).join("")}</tr></tfoot>`
          : ""}
      </table>
    </div>
    </details>
  </section>`;

  const ch = input.changes ?? null;
  /** The spot change a room shows in place of its original, if one is picked. */
  const pickedVersion = (p: PhotoResult, tier: Tier): Version | null => {
    if (!ch) return null;
    const id = ch.versions.picks[pickKey(p.id, tier)];
    return id && id !== ORIGINAL ? ch.versions.versions.find((v) => v.id === id && v.photoId === p.id && v.tier === tier && v.status !== "running" && v.image) ?? null : null;
  };
  const changedSince = (p: PhotoResult, v: Version | null) => {
    if (!v || !ch) return undefined;
    const parent = v.parent === ORIGINAL
      ? ch.originals.find((o) => o.id === p.id)?.tiers.find((t) => t.tier === v.tier)?.plan
      : ch.versions.versions.find((x) => x.id === v.parent && x.photoId === p.id && x.tier === v.tier)?.plan;
    const before = new Map((parent?.changes ?? []).map((c) => [c.element.toLowerCase(), c.proposed]));
    return new Set(v.plan.changes.filter((c) => before.get(c.element.toLowerCase()) !== c.proposed).map((c) => c.element.toLowerCase()));
  };
  const yourChange = (v: Version) => `
    <div class="your-change">
      <p class="your-change-head">Version ${v.id.slice(1)} · Your change</p>
      ${v.request.ask ? `<p>${esc(v.request.ask)}</p>` : ""}
      ${v.request.pins.length ? `<ol class="pin-notes">${v.request.pins.map((pin, i) => `<li><span class="pin-n" aria-hidden="true">${i + 1}</span><span><strong>${esc(sentence(pin.item ?? "Pinned spot"))}:</strong> ${esc(pin.note)}</span>${pin.result ? `<span class="pin-result r-${pin.result}">${pin.result === "done" ? "Done" : pin.result === "partial" ? "Partly done" : "Missed"}</span>` : ""}</li>`).join("")}</ol>` : ""}
      ${v.request.notes ? `<p class="fine">Context: ${esc(v.request.notes)}</p>` : ""}
    </div>`;
  /** Picks which version the report uses for one room and scope. */
  const versionSelect = (p: PhotoResult, tier: Tier, picked: string) => {
    const options = [
      { id: ORIGINAL, text: "Version 1", ok: true },
      ...versionsFor(ch!.versions, p.id, tier).map((v) => ({
        id: v.id,
        text: `Version ${v.id.slice(1)}`,
        ok: v.status !== "running" && !!v.image,
      })),
    ];
    return `<label class="ver-select"><span class="sr-only">Version of the ${tierName(tier)} ${esc(roomName(p).toLowerCase())} used in the report</span><select data-pick data-room="${p.id}" data-tier="${tier}">${options.map((o) => `<option value="${o.id}"${o.id === picked ? " selected" : ""}${o.ok ? "" : " disabled"}>${o.text}</option>`).join("")}</select></label>`;
  };
  const countVersions = (p: PhotoResult, tier: Tier) => (ch ? 1 + versionsFor(ch.versions, p.id, tier).length : 1);

  /** A summary room: the listing photo beside one redesign, with every scope's verdict and cost. */
  const summaryRoom = (p: PhotoResult) => {
    const room = roomName(p);
    const shown = showcase(p, preferred);
    return `
  <section class="room card" id="${p.id}" aria-labelledby="${p.id}-h">
    <div class="room-head">
      <div class="room-title"><h2 id="${p.id}-h">${esc(room)}</h2><span class="file">${esc(p.basename)}</span></div>
    </div>
    <div class="pair">
      <figure class="frame">
        ${zoomable({ src: p.original, alt: `Listing photo of the ${room.toLowerCase()}`, group: p.id, label: `${room} · Listing photo` })}
        <figcaption>Listing photo</figcaption>
      </figure>
      <figure class="frame">
        ${shown?.image
          ? zoomable({ src: shown.image, alt: `${tierName(shown.tier)} redesign of the ${room.toLowerCase()}`, group: p.id, label: `${room} · ${tierName(shown.tier)}`, status: shown.status })
          : `<div class="no-image">No redesign image</div>`}
        <figcaption>${shown ? `${tierName(shown.tier)} · ${TIER_LABELS[shown.tier].blurb}` : ""}</figcaption>
      </figure>
    </div>
    <div class="info">
      <ul class="info-tier scope-lines">${p.tiers.map((t) => {
        const cost = planCost(t.plan);
        return `<li><span class="scope-name">${tierName(t.tier)}</span>${statusTag(t.status)}<span class="num">${cost ? money(cost) : "–"}</span></li>`;
      }).join("")}</ul>
    </div>
  </section>`;
  };

  const rooms = photos.map((p) => {
    if (summary) return summaryRoom(p);
    const room = roomName(p);
    return `
  <section class="room card" id="${p.id}" aria-labelledby="${p.id}-h">
    <div class="room-head">
      <div class="room-title"><h2 id="${p.id}-h">${esc(room)}</h2><span class="file">${esc(p.basename)}</span></div>
      <div class="tabs" role="tablist" aria-label="Scope for ${esc(room)}">
        ${p.tiers.map((t, i) => `<button role="tab" type="button" id="${p.id}-tab-${t.tier}" data-room="${p.id}" data-tier="${t.tier}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" aria-controls="${p.id}-img-${t.tier} ${p.id}-info-${t.tier}">${tierName(t.tier)}<span class="sr-only">, ${STATUS[t.status].label}</span></button>`).join("")}
      </div>
    </div>
    <div class="pair">
      <figure class="frame">
        ${zoomable({ src: p.original, alt: `Listing photo of the ${room.toLowerCase()}`, group: p.id, label: `${room} · Listing photo` })}
        <figcaption>Listing photo</figcaption>
      </figure>
      <div class="frame">
        ${p.tiers.map((t, i) => {
          const v = pickedVersion(p, t.tier), n = countVersions(p, t.tier);
          return `
        <div role="tabpanel" id="${p.id}-img-${t.tier}" aria-labelledby="${p.id}-tab-${t.tier}" data-panel="${p.id}:${t.tier}"${i === 0 ? "" : " hidden"}>
          ${t.image
            ? `<div class="shot">${zoomable({ src: t.image, alt: `${tierName(t.tier)} redesign of the ${room.toLowerCase()}`, group: p.id, label: `${room} · ${tierName(t.tier)}`, status: t.status, room: ch ? p.id : undefined, tier: t.tier, version: v?.id ?? ORIGINAL, edit: !!ch })}${ch ? `<div class="shot-tools"><button type="button" class="shot-btn" data-open-change="${p.id}:${t.tier}" aria-label="Change the ${tierName(t.tier)} ${esc(room.toLowerCase())}" title="Change this redesign">${icon("pencil")}</button>${n > 1 ? versionSelect(p, t.tier, v?.id ?? ORIGINAL) : ""}</div>` : ""}</div>`
            : `<div class="no-image">${STATUS[t.status].label}. ${STATUS[t.status].meaning}.</div>`}
          <p class="figcap">${tierName(t.tier)} · ${TIER_LABELS[t.tier].blurb}</p>
        </div>`;
        }).join("")}
      </div>
    </div>
    <div class="info">
      <div class="info-tier">
        ${p.tiers.map((t, i) => {
          const v = pickedVersion(p, t.tier);
          return `<div role="tabpanel" id="${p.id}-info-${t.tier}" aria-labelledby="${p.id}-tab-${t.tier}" data-panel="${p.id}:${t.tier}"${i === 0 ? "" : " hidden"}>${tierInfo(t, changedSince(p, v))}${v ? yourChange(v) : ""}</div>`;
        }).join("")}
      </div>
      <details class="fold info-listing">
        <summary>About the listing photo</summary>
        ${p.inventory.condition ? `<p>${esc(p.inventory.condition)}</p>` : ""}
        <p class="fine">Kept as is: ${esc(fixedSummary(p) || "nothing structural detected")}</p>
        ${p.inventory.uncertainties.length ? `<h3 class="sub">Can't tell from this photo</h3><ul class="plain">${p.inventory.uncertainties.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>` : ""}
      </details>
    </div>
  </section>`;
  }).join("");

  /** What the inspector's change panel needs: each room's original results, inventory boxes for pins, and every version. */
  const iterData = ch
    ? {
        api: ch.api,
        thumb: ch.api.replace(/^\/api\/runs\//, "/thumb/runs/"),
        rooms: Object.fromEntries(ch.originals.map((o) => [o.id, {
          name: roomName(o),
          boxes: [
            ...o.inventory.changeable.map((c) => ({ item: sentence(c.element), box: c.box, fixed: false })),
            ...o.inventory.fixed.map((f) => ({ item: KIND[f.kind] ?? sentence(f.kind.replace(/_/g, " ")), box: f.box, fixed: true })),
          ],
          tiers: Object.fromEntries(o.tiers.map((t) => [t.tier, { name: tierName(t.tier), image: t.image, status: t.status, rationale: t.plan.rationale, reasons: t.reasons.map(plainReason) }])),
        }])),
        file: ch.versions,
      }
    : null;

  // Ending: where the money goes, and which images not to lean on.
  const decide = `
  <section class="decide card" aria-labelledby="decide-h">
    <h2 id="decide-h">Before you decide</h2>
    <div class="decide-grid" style="--cols:${tiers.length}">
      ${tiers.map((tier) => {
        const x = totals.get(tier);
        const drivers = largestCosts(photos, tier);
        const shaky = photos.filter((p) => ["failed", "error"].includes(p.tiers.find((t) => t.tier === tier)?.status ?? "")).map(roomName);
        return `
      <div class="decide-col">
        <h3>${tierName(tier)}${x ? ` <span class="num">${money(x.range)}</span>` : ""}</h3>
        ${drivers.length
          ? `<p class="fine">Largest costs</p><ol class="drivers">${drivers.map(({ room, c }) => `<li><span>${esc(room)}: ${esc(sentence(c.element))}</span><span class="num">${money({ low: c.costLow, high: c.costHigh })}</span></li>`).join("")}</ol>`
          : `<p class="fine">No cost estimates in this run.</p>`}
        ${shaky.length ? `<p class="shaky">${statusTag("failed")}<span>Inspiration only: ${esc([...new Set(shaky)].join(", "))}</span></p>` : ""}
      </div>`;
      }).join("")}
    </div>
    <p class="end-links">${back ? `<a href="${back.href}" data-back>${icon("arrowLeft")}${back.label}</a>` : ""}<a href="#top">${icon("arrowUp")}Back to top</a></p>
  </section>`;

  const downloads = input.pdf || input.html ? `<div class="share"><div class="dl">
    <button class="share-btn" type="button" aria-label="Download report" title="Download report" aria-expanded="false" aria-controls="dl-report">${icon("download")}</button>
    <div class="dl-menu" id="dl-report" hidden>${[
      input.pdf && { label: "PDF", links: input.pdf, kind: "PDF" },
      input.html && { label: "HTML", links: input.html, kind: "web page" },
    ].filter((d) => !!d).map((d) => `<div class="dl-format"><span class="dl-heading">${d.label}</span>
      <a href="${esc(d.links.summary)}" data-download="summary ${d.kind}" aria-label="Download ${d.label} summary" download>Summary</a>
      <a href="${esc(d.links.full)}" data-download="full scope ${d.kind}" aria-label="Download ${d.label} full scope" download>Full scope</a></div>`).join("")}</div>
    </div><span class="share-status" role="status" aria-live="polite"></span></div>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(docTitle)}</title>
${brandHead}
${appearanceScript}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { --motion:none; }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  html { -webkit-tap-highlight-color:transparent; scrollbar-color:var(--line-strong) transparent; scrollbar-gutter:stable; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 var(--font); caret-color:var(--text); text-wrap:pretty; }
  ::selection { background:color-mix(in srgb, var(--accent) 28%, transparent); }
  a { color:inherit; text-underline-offset:3px; text-decoration-thickness:1px; }
  :focus-visible { outline:2px solid var(--text); outline-offset:2px; border-radius:6px; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .num { font-variant-numeric:tabular-nums; white-space:nowrap; }
  .icon { width:16px; height:16px; flex:none; }
  h1, h2, h3 { margin:0; line-height:1.2; font-weight:600; scroll-margin-top:72px; text-wrap:balance; }
  h1 { font-size:24px; line-height:1.25; letter-spacing:-.01em; }
  h2 { font-size:20px; letter-spacing:-.01em; }
  h3 { font-size:15px; }
  h3.sub { font-size:13px; margin:16px 0 4px; color:var(--muted); font-weight:500; }
  main { max-width:var(--page-max); margin:0 auto; padding:var(--page-top) max(var(--page-gutter), env(safe-area-inset-left)) 120px max(var(--page-gutter), env(safe-area-inset-right)); }
  .skip { position:absolute; left:-999px; } .skip:focus { left:16px; top:16px; background:var(--surface); padding:8px 12px; z-index:9; }

  .crumb { display:inline-flex; align-items:center; gap:2px; min-height:44px; margin:-10px 0 -4px -6px; padding:0 8px 0 2px; border-radius:12px; font-size:14px; font-weight:500; color:var(--muted); text-decoration:none; }
  .crumb:hover { color:var(--text); }
  .page-head { margin:0 0 var(--section-gap); }
  .card { background:var(--surface); border:0; border-radius:16px; box-shadow:var(--shadow); padding:var(--card-padding); }

  .meta { margin:8px 0 0; color:var(--muted); font-size:14px; }
  .meta span + span::before { content:"·"; margin:0 8px; opacity:.6; }
  /* Downloads sit at the right, PDFs above HTML, their bottom edge on the title's baseline row (the row is set inline: 2 under a back link, else 1). */
  .share { position:relative; display:flex; justify-content:flex-end; align-items:center; gap:10px; }
  .dl { position:relative; }
  .dl-caret { width:14px; height:14px; margin-left:-2px; color:var(--muted) !important; --motion:rotate var(--base) var(--ease); }
  .share-btn[aria-expanded="true"] { background:var(--primary-soft); }
  .share-btn[aria-expanded="true"] .dl-caret { rotate:180deg; }
  .dl-menu { position:absolute; z-index:30; top:calc(100% + 6px); right:0; width:min(280px, calc(100vw - 32px)); display:grid; padding:6px; border-radius:14px; background:var(--surface); box-shadow:var(--shadow-hover); }
  .dl-menu { transform-origin:var(--menu-origin, right) top; }
  .dl-menu::before { content:""; position:absolute; top:-4px; left:clamp(12px, var(--menu-origin, 50%), calc(100% - 12px)); width:8px; height:8px; background:var(--surface); transform:translateX(-50%) rotate(45deg); }
  .dl-menu[hidden] { display:none; }
  .dl-menu a { display:grid; min-width:0; gap:2px; padding:8px 10px; border-radius:9px; color:var(--text); text-decoration:none; font-size:14px; font-weight:500; white-space:normal; overflow-wrap:anywhere; }
  .dl-menu a:hover, .dl-menu a:focus-visible { background:var(--surface-2); }
  .dl-menu a[aria-busy="true"] { opacity:.6; cursor:progress; }
  .dl-hint { font-size:13px; font-weight:400; color:var(--muted); }
  .share-btn .icon { color:var(--primary); }
  /* Below the buttons without taking space, so the buttons stay on the baseline while a PDF is prepared. */
  .share-status { position:absolute; top:100%; right:0; margin-top:6px; white-space:nowrap; font-size:13px; color:var(--muted); }
  .share-status:empty { display:none; }
  @media (max-width: 900px) {
    .dl { position:relative; }
    .dl-menu { right:0; left:auto; }
    .share-status { position:static; flex-basis:100%; margin:0; white-space:normal; }
  }
  @media (max-width: 680px) { .dl { flex:1 1 0; } .share-btn { width:100%; justify-content:center; } .dl-menu { width:min(280px, calc(100vw - 32px)); } }
  .page-head > .notice { flex-basis:100%; margin:16px 0 0; }
  @media (min-width:600px) and (max-width:900px) {
    .page-head.whim-detail-header .detail-actions { flex-basis:auto; flex-shrink:0; }
    .page-head.whim-detail-header .detail-actions .share { justify-content:flex-end; flex-wrap:nowrap; }
    .page-head .dl { position:relative; flex:none; }
    .page-head .dl-menu { left:auto; right:0; }
    .page-head .share-status { position:absolute; top:100%; right:0; }
  }

  .status { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:500; white-space:nowrap; }
  .status .icon { width:14px; height:14px; }
  .status-meaning { color:var(--muted); font-weight:400; white-space:normal; }
  .s-verified { color:var(--ok); } .s-review { color:var(--warn); } .s-failed, .s-error { color:var(--bad); } .s-unchanged { color:var(--muted); }
  .status > span:not(.status-meaning) { color:var(--text); }

  .page-head .detail-title { align-items:center; justify-content:space-between; gap:16px; }
  .page-head .detail-title h1 { flex:1; }
  .page-head .detail-title .share { flex:none; }
  .page-head .detail-title .dl { flex:none; }
  .page-head .detail-title .share-btn { display:grid; place-items:center; width:44px; height:44px; min-height:44px; padding:0; border:0; border-radius:14px; background:transparent; color:var(--primary); }
  .page-head .detail-title .share-btn:hover, .page-head .detail-title .share-btn[aria-expanded="true"] { background:var(--surface); }
  .page-head .detail-title .share-btn .icon { width:20px; height:20px; }
  .page-head .detail-title .share-status { position:absolute; top:100%; right:0; width:min(280px, calc(100vw - 32px)); margin-top:6px; white-space:normal; }
  .dl-heading { display:block; padding:6px 10px 2px; color:var(--muted); font-size:12px; font-weight:500; }
  .dl-format + .dl-format { border-top:1px solid var(--line); margin-top:4px; padding-top:4px; }
  /* Overview: image-led plates with gallery-label captions */
  .lede { margin:6px 0 20px; color:var(--muted); max-width:65ch; }
  .scope-albums { display:grid; grid-template-columns:repeat(var(--cols), minmax(0, 1fr)); gap:24px; align-items:start; }
  .scope-album { position:relative; min-width:0; }
  .scope-album > .album-cover { display:flex; align-items:center; gap:24px; list-style:none; }
  .scope-album > .album-cover::-webkit-details-marker { display:none; }
  .scope-link { text-decoration:none; color:inherit; }
  .album-copy { display:grid; gap:4px; min-width:0; flex:1; }
  .album-pile { position:relative; display:block; width:42%; max-width:320px; aspect-ratio:4/3; flex:none; margin:32px 16px; }
  .album-pile { --pile-direction:1; }
  .scope-link:nth-child(even) .album-pile { --pile-direction:-1; }
  .album-pile img { --angle:-5.5deg; --offset:-5%; --lift:3px; position:absolute; width:84%; height:100%; object-fit:cover; border-radius:16px; box-shadow:var(--shadow-hover); left:8%; transform:translateX(calc(var(--offset) * var(--pile-direction))) translateY(var(--lift)) rotate(calc(var(--angle) * var(--pile-direction))); --motion:transform 300ms cubic-bezier(0,.18,.16,2); }
  .album-pile img:nth-child(2) { --angle:5deg; --offset:5%; --lift:11px; }
  .album-pile img:nth-child(3) { --angle:-2deg; --offset:-.5%; --lift:17px; }
  .album-pile img:nth-child(4) { --angle:2deg; --offset:2.5%; --lift:0px; }
  @media (hover:hover) and (prefers-reduced-motion:no-preference) {
    .album-pile:hover img { --angle:-13.5deg; --offset:-4%; --lift:-3px; }
    .album-pile:hover img:nth-child(2) { --angle:7deg; --offset:7%; --lift:12px; }
    .album-pile:hover img:nth-child(3) { --angle:-3.5deg; --offset:-1%; --lift:18px; }
    .album-pile:hover img:nth-child(4) { --angle:0deg; --offset:3.5%; --lift:-1px; }
  }
  @media (prefers-reduced-motion:no-preference) {
    .album-pile:focus-visible img { --offset:calc((var(--i) - 1.5) * 3%); --lift:-3px; }
  }
  .album-open { color:var(--primary); font-size:14px; font-weight:500; }
  .album-close { display:none; }
  .redesign-page { grid-column:1 / -1; }
  .redesign-page > summary { padding-right:96px; cursor:default; }
  .redesign-page .album-pile, .redesign-page .album-open { display:none; }

  .scope-album .plate-total { white-space:normal; overflow-wrap:anywhere; font-size:22px; margin-top:4px; }
  .album-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr)); gap:16px; margin-top:16px; align-items:start; }
  .album-grid figure { margin:0; min-width:0; }
  .album-grid .zoom { aspect-ratio:4/3; }
  .album-grid .zoom img { width:100%; height:100%; object-fit:cover; }
  .album-grid figcaption { font-size:13px; margin-top:6px; }
  .album-facts { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:24px; align-items:start; margin-bottom:24px; }
  .album-summary { margin:0; padding:0; }
  @media(max-width:600px) { .album-facts { grid-template-columns:minmax(0,1fr); gap:12px; } }
  .album-summary > summary { cursor:pointer; font-size:14px; font-weight:500; }
  .album-summary p { max-width:70ch; color:var(--muted); font-size:14px; }
  @media(min-width:601px) {
    .scope-albums:has(> :nth-child(2)) .scope-link > .album-cover { display:grid; grid-template-columns:minmax(0,1fr); gap:12px; }
    .scope-albums:has(> :nth-child(2)) .scope-link .album-pile { width:calc(100% - 16px); max-width:none; aspect-ratio:3/2; }
  }
  @media(max-width:600px) {
    .scope-albums { grid-template-columns:minmax(0,1fr); gap:24px; }
    .scope-album > .album-cover { flex-wrap:nowrap; gap:12px; align-items:center; }
    .album-pile { width:45%; margin:28px 8px; }
    .album-copy .plate-sub { display:none; }
    .album-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .scope-album .plate-total { font-size:18px; }
  }

  .plates { display:grid; gap:0 20px; grid-template-columns:repeat(var(--cols), minmax(0, 1fr)); }
  /* Each plate spans the same rows, so titles, totals, and tallies line up across all four. */
  .plate { margin:0; min-width:0; display:grid; grid-row:span 7; grid-template-rows:subgrid; align-content:start; }
  .plate figcaption { display:grid; grid-row:span 6; grid-template-rows:subgrid; padding-top:12px; }
  .plate figcaption > * { align-self:start; }
  .plate-title { font-weight:600; }
  .plate-sub { color:var(--muted); font-size:13px; }
  .plate-total { font-size:22px; font-weight:500; letter-spacing:-.01em; margin-top:10px; line-height:1.25; }
  .plate-tally { font-size:13px; margin-top:8px; color:var(--muted); }
  .legend { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:16px 24px; margin:24px 0 0; padding:16px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
  .legend div { display:grid; gap:4px; align-content:start; } .legend dt, .legend dd { margin:0; line-height:20px; } .legend dt .status { line-height:20px; } .legend dd { color:var(--muted); font-size:13px; }
  .method p { color:var(--muted); font-size:14px; margin:0 0 10px; max-width:72ch; }
  .section-fold { border-bottom:0 !important; }
  details.fold.section-fold > summary { display:grid; grid-template-columns:minmax(0, 1fr) 16px; min-height:56px; gap:8px 14px; padding:12px 0; }
  .section-fold > summary h2 { grid-column:1; grid-row:1; margin:0; scroll-margin-top:72px; }
  .section-fold > summary .fold-meta { grid-column:1; grid-row:2; min-width:0; }
  details.fold.section-fold > summary::after { grid-column:2; grid-row:1 / 3; margin:0; justify-self:center; align-self:center; }
  .fold-meta { color:var(--muted); font-size:13px; font-weight:400; }

  /* Images */
  .zoom { position:relative; display:block; width:100%; padding:0; border:0; background:var(--surface-2); border-radius:3px; overflow:hidden; cursor:zoom-in; aspect-ratio:3 / 2; }
  .zoom img { width:100%; height:100%; object-fit:cover; display:block; --motion:transform .5s var(--ease); }
  .zoom:hover img { transform:scale(1.015); }
  .no-image { aspect-ratio:3 / 2; display:grid; place-items:center; border-radius:3px; border:1px dashed var(--line-strong); color:var(--muted); font-size:13px; text-align:center; padding:16px; }

  /* By room */
  .by-room { margin-top:var(--section-gap); padding-top:4px; padding-bottom:4px; }
  .table-scroll { margin-top:8px; overflow-x:auto; width:100%; min-width:0; max-width:100%; }
  .by-room details { min-width:0; max-width:100%; overflow:hidden; }
  table { width:100%; min-width:560px; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; vertical-align:top; padding:12px 16px 12px 0; border-bottom:1px solid var(--line); }
  thead th { font-weight:500; color:var(--muted); font-size:13px; padding-bottom:8px; }
  tbody th { font-weight:500; } tbody th a { text-decoration:none; } tbody th a:hover { text-decoration:underline; }
  .room-link { display:flex; align-items:center; gap:12px; }
  .room-thumb { width:64px; height:48px; object-fit:cover; border-radius:7px; background:var(--surface-2); flex:none; }
  .cell-cost { margin-top:4px; color:var(--muted); font-size:13px; }
  tfoot th, tfoot td { border-bottom:0; padding-top:14px; font-weight:600; font-size:15px; }

  /* Sticky controls */
  .toolbar { position:fixed; top:0; left:var(--toolbar-left, 16px); width:var(--toolbar-width, calc(100% - 32px)); z-index:5; display:grid; grid-template-columns:auto minmax(180px, 1fr) auto; gap:12px 16px; align-items:center; margin:0; padding:12px 0; background:color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter:saturate(1.2) blur(10px); border-bottom:1px solid var(--line); }
  .toolbar .crumb { margin:0; padding:0 8px; min-width:44px; justify-content:center; }
  .toolbar:not(:has(.crumb)) { grid-template-columns:minmax(0, 1fr) auto; }
  .room-picker { position:relative; min-width:0; width:min(100%, 260px); justify-self:start; }
  .room-picker > summary { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; min-height:44px; padding:8px 12px; border:1px solid var(--line-strong); border-radius:12px; background:var(--surface); font-size:14px; list-style:none; cursor:pointer; }
  .room-picker > summary::-webkit-details-marker { display:none; }
  .room-picker > summary .icon { flex:none; width:16px; height:16px; }
  .room-picker[open] > summary .icon { rotate:180deg; }
  .room-menu { position:absolute; z-index:30; top:calc(100% + 6px); left:0; width:max(100%, 360px); max-height:min(360px, 55dvh); overflow-y:auto; overscroll-behavior:contain; padding:6px; margin:0; list-style:none; border:1px solid var(--line-strong); border-radius:14px; background:var(--surface); box-shadow:var(--shadow-hover); }
  .room-menu button { display:block; width:100%; min-height:44px; padding:10px; border:0; border-radius:9px; font:inherit; font-size:14px; line-height:1.4; text-align:left; white-space:normal; overflow-wrap:anywhere; background:transparent; color:var(--text); cursor:pointer; }
  .room-menu button:hover, .room-menu button:focus-visible { background:var(--surface-2); }
  .room-picker[data-placement="above"] .room-menu { top:auto; bottom:calc(100% + 6px); }

  .toolbar-scope { display:flex; align-items:center; gap:12px; min-width:0; }
  .toolbar-scope .seg { flex:none; }
  @media (min-width:681px) and (max-width:1100px) {
    .toolbar { grid-template-columns:minmax(0, auto) minmax(150px, 1fr) auto; gap:12px; }
    .toolbar .crumb { max-width:190px; justify-content:flex-start; }
    .toolbar .crumb span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .toolbar-scope { justify-content:flex-end; }
    .toolbar-scope .seg-label { display:none; }
    .toolbar-scope .seg button { padding-inline:8px; }
  }
  select { max-width:100%; min-width:0; font:inherit; font-size:14px; min-height:36px; padding:6px 30px 6px 10px; border-radius:12px; border:1px solid var(--line-strong); color:inherit; background:var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%2366625d' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E") no-repeat right 8px center; appearance:none; }
  .seg { display:inline-flex; padding:3px; border:1px solid var(--line-strong); border-radius:12px; background:var(--surface); }
  .seg button { font:inherit; font-size:13px; font-weight:500; min-height:32px; padding:4px 12px; border:0; border-radius:9px; background:transparent; color:var(--text); cursor:pointer; touch-action:manipulation; }
  .seg button:hover { background:var(--surface-2); }
  .seg button[aria-pressed="true"] { background:var(--primary); color:var(--primary-text); font-weight:600; }
  .seg-label { font-size:13px; color:var(--muted); }

  /* Rooms */
  .room { margin-top:var(--section-gap); scroll-margin-top:calc(var(--toolbar-height, 56px) + 16px); }
  .room-head { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:start; gap:12px 24px; margin-bottom:16px; }
  .room-title { flex:1 1 360px; min-width:0; }
  .room-title h2 { margin:0; overflow-wrap:anywhere; }
  .room-title .file { display:block; margin-top:8px; overflow-wrap:anywhere; }
  .room-head > .tabs { flex:none; }
  .file { font-size:13px; color:var(--muted); }
  .tabs { display:inline-flex; padding:3px; border:1px solid var(--line-strong); border-radius:12px; background:var(--surface); }
  .tabs [role="tab"] { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:13px; font-weight:500; min-height:34px; padding:4px 12px; border:0; border-radius:9px; background:transparent; color:var(--text); cursor:pointer; touch-action:manipulation; }
  .tabs [role="tab"]:hover { background:var(--surface-2); }
  .tabs [role="tab"][aria-selected="true"] { background:var(--primary); color:var(--primary-text); font-weight:600; }
  .pair { display:grid; gap:12px; grid-template-columns:repeat(2, minmax(0, 1fr)); }
  .frame { margin:0; min-width:0; }
  /* Version dropdowns sit over the bottom-right corner of the image, on the report and in the inspector. */
  .shot { position:relative; }
  .shot-tools { position:absolute; right:10px; bottom:10px; z-index:2; display:flex; gap:6px; align-items:center; }
  .shot-btn { width:30px; height:30px; display:grid; place-items:center; padding:0; border:0; border-radius:12px; color:#fff; background:rgba(18,18,17,.62); -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); box-shadow:0 1px 4px rgba(0,0,0,.25); cursor:pointer; }
  .shot-btn .icon { width:16px; height:16px; }
  .shot-btn:hover { background:rgba(18,18,17,.78); }
  .shot-btn:focus-visible { outline:2px solid #fff; outline-offset:2px; }
  @media (hover:hover) {
    .shot-btn { opacity:0; transition:opacity .15s ease; }
    .shot:hover .shot-btn, .shot:focus-within .shot-btn { opacity:1; }
  }

  /* Version pickers are plain native selects over the image. */
  .ver-select select, .viewer-ver { all:revert; font:inherit; font-size:13px; cursor:pointer; }
  .viewer-ver { color-scheme:dark; }
  .ver-select select[disabled] { opacity:.6; cursor:progress; }
  .frame figcaption, .figcap { margin:8px 0 0; font-size:13px; line-height:20px; color:var(--muted); min-height:20px; }
  /* Spot changes */
  .your-change { margin-top:12px; padding:10px 12px; border-radius:12px; background:var(--surface-2); font-size:14px; }
  .your-change p { margin:0; }
  .your-change-head { font-size:12px !important; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); margin-bottom:2px !important; }
  .pin-notes { list-style:none; margin:4px 0 0; padding:0; display:grid; gap:4px; }
  .pin-notes li { display:flex; gap:8px; align-items:baseline; }
  .pin-notes strong { font-weight:500; }
  .pin-n { flex:none; width:20px; height:20px; border-radius:50%; background:var(--primary); color:var(--primary-text); font-size:11px; font-weight:600; display:inline-grid; place-items:center; }
  .pin-result { margin-left:auto; font-size:12px; white-space:nowrap; color:var(--ok); }
  .pin-result.r-missed, .pin-result.r-partial { color:var(--warn); }
  .changed-tag { margin-left:8px; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--primary); }
  .info { display:grid; gap:12px; grid-template-columns:repeat(2, minmax(0, 1fr)); margin-top:16px; align-items:start; }
  .info > * { min-width:0; }
  .info-tier { grid-column:2; grid-row:1; }
  .info-listing { grid-column:1; grid-row:1; }
  .verdict { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:4px 16px; min-height:44px; padding:6px 0; border-bottom:1px solid var(--line); }
  .verdict .status { white-space:normal; flex-wrap:wrap; }
  .verdict-cost { font-size:18px; font-weight:500; }
  .scope-lines { list-style:none; margin:0; padding:0; }
  .scope-lines li { display:grid; grid-template-columns:minmax(0, 1fr) auto auto; align-items:center; gap:4px 16px; min-height:40px; padding:6px 0; border-bottom:1px solid var(--line); font-size:14px; }
  .scope-lines .scope-name { font-weight:500; }

  details.fold { border-bottom:1px solid var(--line); }
  details.fold > summary { display:flex; align-items:center; gap:8px; min-height:48px; padding:12px 0; line-height:20px; cursor:pointer; list-style:none; font-weight:500; font-size:14px; }
  details.fold > summary::-webkit-details-marker { display:none; }
  details.fold > summary::after { content:""; margin-left:auto; margin-right:3px; flex:none; width:7px; height:7px; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:translateY(var(--fold-y, -2px)) rotate(var(--fold-angle, 45deg)); --motion:transform .2s; }
  details.fold[open] > summary { --fold-y:2px; --fold-angle:-135deg; }
  details.fold[open] { padding-bottom:14px; }
  .count { flex:none; line-height:18px; font-size:12px; color:var(--muted); font-weight:500; padding:1px 7px; border-radius:999px; background:var(--surface-2); }
  .info-listing p, .checks, .plain { font-size:14px; }
  .info-listing p { margin:0 0 8px; max-width:65ch; }
  .checks, .plain { margin:0; padding-left:18px; display:grid; gap:6px; max-width:70ch; }
  .checks li::marker, .plain li::marker { color:var(--muted); }
  .direction { color:var(--muted); font-size:13px; margin:0 0 10px; }
  .changes { list-style:none; margin:0; padding:0; display:grid; }
  .changes li { padding:12px 0; border-top:1px solid var(--line); }
  .changes li:first-child { border-top:0; padding-top:4px; }
  .change-head { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
  .changes p { margin:4px 0 0; font-size:14px; max-width:65ch; }
  .was, .basis { color:var(--muted); font-size:13px !important; }
  .fine { color:var(--muted); font-size:13px; margin:12px 0 0; }

  /* Ending */
  .decide { margin-top:40px; }
  .decide-grid { display:grid; gap:32px; margin-top:24px; grid-template-columns:repeat(var(--cols), minmax(0, 1fr)); }
  .decide-col h3 { display:flex; justify-content:space-between; gap:12px; align-items:baseline; font-size:16px; padding-bottom:10px; border-bottom:1px solid var(--line); }
  .decide-col h3 .num { font-weight:500; }
  .drivers { list-style:none; margin:8px 0 0; padding:0; font-size:14px; }
  .drivers li { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--line); }
  .shaky { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; font-size:14px; margin:14px 0 0; }
  .end-links { display:flex; gap:24px; margin-top:32px; font-size:14px; }
  .end-links a { display:inline-flex; gap:6px; align-items:center; color:var(--muted); text-decoration:none; } .end-links a:hover { color:var(--text); }

  @media (max-width: 900px) {
    .plates { grid-template-columns:repeat(2, minmax(0, 1fr)); }
    .decide-grid { grid-template-columns:minmax(0, 1fr); }
  }
  @media (max-width: 680px) {
    .legend { grid-template-columns:minmax(0, 1fr); gap:12px; }
    main { padding-top:16px; }
    @media (display-mode: standalone) { main { padding-top:var(--standalone-top); } } /* clear iOS's blur under the status bar */
    .pair, .info { grid-template-columns:minmax(0, 1fr); }
    .info-tier, .info-listing { grid-column:1; grid-row:auto; }
    .toolbar .crumb span { display:none; }
    .toolbar-scope { display:none; } /* each room keeps its own scope tabs on small screens */
    .toolbar { grid-template-columns:44px minmax(0, 1fr); gap:12px; }
    .room-picker, .room-menu { width:100%; }
    .toolbar:not(:has(.crumb)) { grid-template-columns:minmax(0, 1fr); }
    .info { row-gap:0; }
    .room-head { align-items:start; }
    .tabs { width:100%; } .tabs [role="tab"] { flex:1; min-width:0; padding-inline:6px; font-size:12px; justify-content:center; }
  }

  .to-top { position:fixed; right:max(16px, env(safe-area-inset-right)); bottom:max(16px, env(safe-area-inset-bottom)); z-index:6; width:44px; height:44px; display:grid; place-items:center; border-radius:50%; border:0; background:var(--surface); box-shadow:0 4px 16px rgba(0,0,0,.14); color:inherit; cursor:pointer; opacity:0; transform:translateY(8px); --motion:opacity .25s, transform .25s var(--ease); pointer-events:none; }
  .to-top.show { opacity:1; transform:none; pointer-events:auto; }

  dialog.viewer { width:100%; height:100dvh; max-width:none; max-height:none; margin:0; padding:0; border:0; background:#0f0f0e; color:#efede9; }
  dialog.viewer::backdrop { background:rgba(0,0,0,.85); }
  /* While a swipe closes the viewer, the page behind shows through right away (the dialog fades its own background). */
  dialog.viewer.dismissing::backdrop { background:transparent; }
  /* The page behind the photo viewer stays put while it is open. */
  html:has(dialog.viewer[open]) { overflow:hidden; }
  dialog.viewer { overscroll-behavior:contain; }
  dialog.viewer[open] { display:flex; flex-direction:column; }
  dialog.viewer:focus { outline:none; }
  /* Fixed columns and a reserved status line, so switching versions never moves the tabs or the image. */
  .viewer-bar { display:grid; grid-template-columns:minmax(0, 1fr) auto minmax(0, 1fr); gap:8px 16px; align-items:center; padding:0 max(14px, env(safe-area-inset-left)); border-bottom:1px solid rgba(255,255,255,.1); height:66px; flex:none; }
  .viewer-title { display:grid; grid-template-rows:20px 20px; gap:2px; min-width:0; }
  .viewer-body { position:relative; }
  .viewer-ver { position:absolute; z-index:3; }
  .viewer-title strong, #viewer-status { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:20px; }
  #viewer-status .status { white-space:nowrap; }
  .viewer-plain { color:rgba(239,237,233,.6); font-size:13px; }
  .viewer-actions { justify-self:end; }
  .viewer-title strong { font-weight:500; }
  .viewer-title .status > span:not(.status-meaning) { color:#efede9; }
  .viewer-title .status-meaning { color:rgba(239,237,233,.6); }
  .viewer-title .s-verified { color:#8fc49f; } .viewer-title .s-review { color:#e0bd78; } .viewer-title .s-failed, .viewer-title .s-error { color:#ee9d90; }
  .viewer .seg { background:rgba(255,255,255,.08); } .viewer .seg button { color:rgba(239,237,233,.7); } .viewer .seg button[aria-pressed="true"] { background:#efede9; color:#0f0f0e; }
  .viewer button:focus-visible { outline:2px solid #efede9; outline-offset:-3px; border-radius:9px; }
  .viewer .seg button[aria-pressed="true"]:focus-visible { outline-color:#0f0f0e; }
  .viewer-actions { display:flex; gap:6px; align-items:center; }
  .vbtn { font:inherit; font-size:13px; min-height:36px; padding:4px 12px; border-radius:12px; border:1px solid rgba(255,255,255,.22); background:transparent; color:inherit; cursor:pointer; }
  .vbtn[aria-pressed="true"] { background:#efede9; color:#0f0f0e; }
  .viewer-close { display:grid; place-items:center; width:36px; padding:0; }
  .viewer-badge { display:none; }
  .viewer-close .icon { width:18px; height:18px; }
  .viewer-body { flex:1; min-height:0; display:flex; }
  .viewer-stage { background-position:center; background-repeat:no-repeat; background-size:contain; position:relative; flex:1; min-width:0; min-height:0; overflow:auto; overscroll-behavior:contain; touch-action:none; display:flex; cursor:zoom-in; }
  .viewer-stage img { flex:none; margin:auto; max-width:100%; max-height:100%; object-fit:contain; display:block; user-select:none; -webkit-user-drag:none; -webkit-touch-callout:none; }
  .viewer-stage.actual { cursor:grab; } .viewer-stage.actual.dragging { cursor:grabbing; }
  .viewer-stage.actual img { max-width:none; max-height:none; }
  @media (max-width: 680px) {
    .viewer-bar { grid-template-columns:minmax(0, 1fr) auto auto; grid-template-rows:auto auto; gap:8px 6px; height:auto; padding-block:10px; }
    .viewer-title .status-meaning { display:none; }
    .viewer .vbtn, .viewer .seg button, .viewer-tabs button { min-height:44px; }
    .viewer-title { grid-column:1 / 3; grid-row:1; }
    .viewer-actions { display:contents; }
    .viewer-actions > [data-viewer="close"] { grid-column:3; grid-row:1; justify-self:end; }
    .viewer-iter { grid-column:2; grid-row:2; }
    .viewer.iter-closed .viewer-stage, .viewer.iter-none .viewer-stage { flex:1; aspect-ratio:auto; max-height:none; }
    .viewer-tabs { grid-column:1; grid-row:2; justify-self:start; min-width:0; max-width:100%; overflow:auto; }
    .viewer-tabs button { flex:none; padding-inline:8px; }
      .viewer-zoom { grid-column:3; grid-row:2; }
    }
  /* Change panel: a conversation beside the image, where each reply is a new version. */
  .iter { flex:none; width:380px; display:flex; flex-direction:column; min-height:0; border-left:1px solid rgba(255,255,255,.1); background:#161615; font-size:14px; }
  .iter-head { display:flex; align-items:center; gap:10px; min-height:52px; padding:10px 16px 6px; }
  .iter-head h2 { font-size:15px; font-weight:600; line-height:20px; margin:0; }
  .iter-head .iter-sub { line-height:20px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .iter-close { flex:none; margin-left:auto; width:32px; height:32px; min-height:0; padding:0; display:grid; place-items:center; }
  .iter-close .icon { width:16px; height:16px; display:block; }
  .viewer.iter-closed .iter, .viewer.iter-none .iter, .viewer.iter-none .viewer-iter { display:none; }
  .viewer-iter { display:grid; place-items:center; width:36px; padding:0; }
  .viewer-iter .icon { width:18px; height:18px; }
  .iter-sub, .iter-base, .iter-status { color:rgba(239,237,233,.6); font-size:13px; }
  .iter-log { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:4px 16px 32px; display:flex; flex-direction:column; gap:14px; }
  .msg p { margin:6px 0 0; line-height:1.45; }
  .msg.user { align-self:flex-end; max-width:88%; padding:10px 12px; border-radius:18px 18px 6px 18px; background:#2a2a28; }
  .msg.user > :first-child { margin-top:0; }
  .msg-from { font-size:12px; color:rgba(239,237,233,.55); }
  .msg.bot p { color:rgba(239,237,233,.78); }
  .msg-shot { display:block; width:100%; aspect-ratio:3 / 2; padding:0; border:0; border-radius:14px; overflow:hidden; background:#232322; cursor:pointer; }
  .msg-shot img { width:100%; height:100%; object-fit:cover; display:block; }
  .msg-shot:hover img { opacity:.9; }
  .msg-shot:focus-visible { outline:2px solid #efede9; outline-offset:2px; }
  .msg-meta { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:8px; }
  .msg-meta strong { font-weight:600; }
  .msg .status { font-size:12.5px; gap:5px; }
  .msg .status .icon { width:14px; height:14px; }
  .iter .status > span { color:inherit; }
  .iter .s-verified { color:#8fc49f; } .iter .s-review, .iter .s-unchanged { color:#e0bd78; } .iter .s-failed, .iter .s-error { color:#ee9d90; }
  .msg-pins { list-style:none; margin:6px 0 0; padding:0; display:grid; gap:5px; }
  .msg-pins li { display:flex; gap:8px; align-items:baseline; }
  .msg-pins strong { font-weight:500; }
  .msg .pin-n, .iter-pins .pin-n { background:#efede9; color:#0f0f0e; }
  .msg .pin-result { color:#8fc49f; } .msg .pin-result.r-missed, .msg .pin-result.r-partial { color:#e0bd78; }
  .msg-refs { display:flex; gap:6px; margin-top:8px; }
  .msg-refs img { width:56px; height:42px; object-fit:cover; border-radius:9px; }
  .msg-warn { color:#e0bd78 !important; font-size:13px; }
  .msg-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:10px; }
  .ibtn { font:inherit; font-size:13px; min-height:32px; padding:4px 12px; border-radius:12px; border:1px solid rgba(255,255,255,.22); background:transparent; color:inherit; cursor:pointer; }
  .ibtn:hover { background:rgba(255,255,255,.08); }
  .ibtn.quiet { border-color:transparent; color:rgba(239,237,233,.6); }
  .ibtn[disabled] { opacity:.5; cursor:progress; }
  .in-report { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:#8fc49f; padding-right:6px; }
  .in-report .icon { width:14px; height:14px; }
  .msg-work { padding:14px; border-radius:14px; background:#232322; display:grid; gap:10px; }
  .msg-step { font-size:13px; color:rgba(239,237,233,.75); }
  .msg-bar { height:4px; border-radius:2px; background:rgba(255,255,255,.12); overflow:hidden; }
  .msg-bar i { display:block; height:100%; width:4%; background:#efede9; transition:width .5s linear; }
  .iter-compose { position:relative; flex:none; display:grid; gap:8px; padding:4px 16px max(12px, env(safe-area-inset-bottom)); background:#161615; }
  /* The conversation fades out behind the prompt instead of cutting off. */
  .iter-compose::before { content:""; position:absolute; left:0; right:0; bottom:100%; height:32px; background:linear-gradient(to bottom, rgba(22,22,21,0), #161615); pointer-events:none; }
  .iter-base, .iter-status { margin:0; }
  .iter-base:empty { display:none; }
  .iter-status:empty { display:none; }
  .iter-status.error { color:#ee9d90; }
  /* One rounded composer box: photos on top, the prompt, then tools and send inside it. */
  .iter-box { display:grid; gap:6px; padding:10px 8px 8px; border:1px solid rgba(255,255,255,.12); border-radius:22px; background:#232322; }
  .iter-box:focus-within { border-color:rgba(255,255,255,.3); }
  .iter-box .iter-refs { padding:0 4px; }
  .iter-compose textarea { width:100%; font:inherit; font-size:14px; line-height:1.45; color:#efede9; background:transparent; border:0; padding:2px 6px; resize:none; outline:none; }
  .iter-pins input:focus { outline:2px solid #efede9; outline-offset:-1px; }
  .iter-compose textarea::placeholder, .iter-pins input::placeholder { color:rgba(239,237,233,.45); }
  .iter-pins { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
  .iter-pins:empty, .iter-refs:empty { display:none; }
  /* Pin row: badge and item name on one line, the note and its remove button lined up below. */
  .iter-pins li { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; gap:4px 8px; align-items:center; }
  .iter-pins .pin-n { grid-column:1; grid-row:1; margin:0; }
  .iter-pins .ipin-item { grid-column:2 / 4; grid-row:1; }
  .ipin-item { font-size:12px; color:rgba(239,237,233,.6); }
  .iter-pins input { grid-column:2; grid-row:2; width:100%; font:inherit; font-size:13px; color:#efede9; background:#232322; border:1px solid rgba(255,255,255,.16); border-radius:12px; padding:6px 9px; }
  .iter-pins li > button { grid-column:3; grid-row:2; }
  .iter-refs { display:flex; gap:6px; }
  .iref { padding:0; border:0; background:none; border-radius:9px; cursor:pointer; }
  .iref img { width:56px; height:42px; object-fit:cover; border-radius:9px; display:block; }
  .iref:hover img { opacity:.55; }
  .iter-tools { display:flex; align-items:center; gap:4px; }
  .itool { display:inline-flex; align-items:center; gap:5px; min-height:32px; padding:4px 10px; border-radius:999px; border:1px solid transparent; background:transparent; color:rgba(239,237,233,.75); font:inherit; font-size:13px; cursor:pointer; }
  .itool .icon { width:16px; height:16px; }
  .itool:hover { background:rgba(255,255,255,.08); color:#efede9; }
  .itool[aria-pressed="true"] { background:#efede9; color:#0f0f0e; }
  .itool:focus-within { outline:2px solid #efede9; outline-offset:-2px; }
  .itool[hidden] { display:none; }
  .isend { margin-left:auto; width:34px; height:34px; display:grid; place-items:center; padding:0; border:0; border-radius:50%; background:#efede9; color:#0f0f0e; cursor:pointer; }
  .isend .icon { width:18px; height:18px; }
  .isend[disabled] { opacity:.4; cursor:progress; }
  .vpins { position:absolute; left:0; top:0; width:0; height:0; }
  .vpin { position:absolute; width:28px; height:28px; margin:-14px 0 0 -14px; padding:0; display:grid; place-items:center; border-radius:50%; border:2px solid #fff; background:#2f5a44; color:#fff; font:600 13px/1 var(--font); box-shadow:0 1px 6px rgba(0,0,0,.45); cursor:pointer; }
  .vpin.saved { opacity:.75; cursor:default; }
  .vpin.r-missed, .vpin.r-partial { background:#8a6216; }
  .viewer-stage.pinning, .viewer-stage.pinning img { cursor:crosshair; }
  @media (max-width: 680px) {
    .viewer-body { flex-direction:column; }
    .viewer-stage { flex:none; aspect-ratio:3 / 2; max-height:45dvh; }
    .iter { width:auto; flex:1; border-left:0; border-top:1px solid rgba(255,255,255,.1); }
  }
  @media (max-width: 860px), (hover: none) and (pointer: coarse) and (orientation: landscape) and (max-height: 600px) {
    .viewer .vbtn, .viewer .seg button { min-height:44px; }
    .viewer, .viewer * { -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }
    .shot-tools, .viewer .viewer-iter, .viewer .iter, .viewer .viewer-ver, .viewer .vpins, .viewer .viewer-tabs, .viewer .viewer-zoom { display:none !important; }
    .viewer .viewer-stage { flex:1; aspect-ratio:auto; max-height:none; }
    /* Phones: tap flips versions, so the bar is just the title and an X, floating over the photo. */
    .viewer .viewer-bar { position:absolute; z-index:8; top:0; left:0; right:0; height:auto; grid-template-columns:minmax(0, 1fr) auto; grid-template-rows:auto; gap:12px; padding:calc(env(safe-area-inset-top) + 8px) max(12px, env(safe-area-inset-right)) 10px max(16px, env(safe-area-inset-left)); border-bottom:0; background:rgba(15,15,14,.38); -webkit-backdrop-filter:blur(20px) saturate(1.4); backdrop-filter:blur(20px) saturate(1.4); text-shadow:0 1px 2px rgba(0,0,0,.45); }
    .viewer .viewer-title { grid-column:1; grid-row:1; }
    /* Which version is on screen; the listing photo gets a light pill so it never passes for a redesign. */
    .viewer .viewer-badge { position:absolute; z-index:7; left:50%; bottom:calc(env(safe-area-inset-bottom) + 20px); transform:translateX(-50%); display:flex; align-items:center; gap:8px; padding:7px 12px; border-radius:999px; background:rgba(15,15,14,.55); -webkit-backdrop-filter:blur(16px); backdrop-filter:blur(16px); color:#efede9; font-size:13px; font-weight:600; line-height:18px; white-space:nowrap; touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,.25); }
    .viewer .viewer-badge.original { background:#efede9; color:#0f0f0e; }
    .viewer-badge .dots { display:flex; gap:4px; }
    .viewer-badge .dots i { width:6px; height:6px; border-radius:50%; background:currentColor; opacity:.35; }
    .viewer-badge .dots i.on { opacity:1; }
    .viewer-badge.pop { animation:badge-pop .28s cubic-bezier(.22,1,.36,1); }
    @keyframes badge-pop { from { transform:translateX(-50%) scale(.86); opacity:.5; } }
    @media (prefers-reduced-motion: reduce) { .viewer-badge.pop { animation:none; } }
    .viewer .viewer-actions > [data-viewer="close"] { grid-column:2; grid-row:1; width:44px; min-height:44px; border:0; border-radius:50%; background:rgba(255,255,255,.14); }
  }
  .viewer-stage.reeling { overflow:hidden; }
  .viewer-neighbor { position:absolute; inset:0; background:#0f0f0e; background-position:center; background-repeat:no-repeat; background-size:contain; pointer-events:none; will-change:transform; }
  .viewer-split { position:absolute; inset:0; z-index:5; pointer-events:none; background-position:center; background-repeat:no-repeat; background-size:contain; }
  .viewer-divider { position:absolute; top:0; bottom:0; width:2px; z-index:6; background:white; box-shadow:0 0 8px #0008; pointer-events:none; }
  .viewer-stage.comparing { cursor:ew-resize; overflow:hidden; }
  .viewer-stage.comparing img { pointer-events:none; }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior:auto !important; } }

  /* Motion + depth system */
  /* Every clickable element presses to 98% on the fast duration. */
  button, .btn, a.nav-link, .tier, .pick, .zoom, summary, [role="tab"] { --motion:transform var(--fast) var(--ease), box-shadow var(--base) var(--ease), background-color var(--base) var(--ease), border-color var(--base) var(--ease), color var(--base) var(--ease), opacity var(--base) var(--ease); }
  button:active:not(:disabled), .btn:active, a.nav-link:active, .tier:active, .pick:active, .zoom:active, summary:active, [role="tab"]:active { transform:scale(0.98); }
  /* Motion fades and lifts tooltip pseudo-elements through these custom properties. */
${back ? `${mobileTabsCss}
  /* On a phone the tab bar carries navigation, so the logo row above the title goes. */
  @media (max-width:860px) { .report-brand { display:none; } }
  /* The back-to-top button sits at the right of the tab bar, on the same horizontal line (both scale from the bottom edge). */
  @media (max-width:860px) {
    .mobile-tabs { left:max(16px, env(safe-area-inset-left)); width:calc(100% - 32px - 56px); transform-origin:0 100%; transform:scale(var(--nav-scale, 1)); }
    .to-top { bottom:calc(max(8px, env(safe-area-inset-bottom)) + 32px * var(--nav-scale, 1) - 22px); }
  }` : ""}
</style>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<main id="content">
  ${back ? `<a class="report-brand" href="/" aria-label="Whim home">${brandLockup}</a>` : `<div class="report-brand" role="img" aria-label="Whim">${brandLockup}</div>`}
  ${renderPageHeader({ className: "page-head",
    back: input.redesignScope ? `<a class="back-link" href="report.html">${icon("arrowLeft")}Report</a>` : back ? `<a class="back-link" href="${back.href}" data-back>${icon("arrowLeft")}${esc(input.title)}</a>` : "",
    title: `<h1 id="top" tabindex="-1">${esc(displayTitle)}</h1>${downloads}`,
    metadata: `<p class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</p>`,
    notice: input.run?.stopped ? `<p class="notice">This run was stopped early, so some rooms or scopes are missing.</p>` : "",
  })}
  ${overview}
  ${input.redesignScope ? "" : table}

  <div class="toolbar" hidden>
    ${back ? `<a class="crumb" href="${back.href}" data-back aria-label="${back.label}">${icon("arrowLeft")}<span>${esc(input.title)}</span></a>` : ""}
    <details class="room-picker" id="room-jump">
      <summary aria-label="Jump to room">Jump to room…${icon("chevronDown")}</summary>
      <ul class="room-menu" aria-label="Rooms">${photos.map((p) => `<li><button type="button" data-jump-room="${esc(p.id)}">${esc(roomName(p))}</button></li>`).join("")}</ul>
    </details>
    ${tiers.length > 1 && !summary
      ? `<div class="toolbar-scope"><span class="seg-label" id="seg-label">Show in every room</span><div class="seg" role="group" aria-labelledby="seg-label">${tiers.map((t) => `<button type="button" data-all-tier="${t}" aria-pressed="false">${tierName(t)}</button>`).join("")}</div></div>`
      : ""}
  </div>

  ${input.redesignScope ? "" : rooms}
  ${input.redesignScope ? "" : decide}
</main>

<button class="to-top" type="button" aria-label="Back to top" tabindex="-1">${icon("arrowUp")}</button>

<dialog class="viewer iter-closed" aria-labelledby="viewer-title" tabindex="-1">
  <div class="viewer-bar">
    <div class="viewer-title"><strong id="viewer-title"></strong><span id="viewer-status"></span></div>
    <div class="seg viewer-tabs" role="group" aria-label="Compare versions"></div>
    <div class="viewer-actions">${ch ? `
      <button class="vbtn viewer-iter" type="button" data-viewer="changes" aria-pressed="false" aria-controls="iter-panel" aria-label="Changes" title="Show or hide changes (C)">${icon("pencil")}</button>` : ""}
      <div class="seg viewer-zoom" role="group" aria-label="Image size">
        <button type="button" data-viewer="fit" aria-pressed="true" title="Fit (Z)">Fit</button>
        <button type="button" data-viewer="actual" aria-pressed="false" title="Actual size (Z)">100%</button>
      </div>
      <button class="vbtn viewer-close" type="button" data-viewer="close" aria-label="Close" title="Close (Esc)">${icon("x")}</button>
    </div>
  </div>
  <div class="viewer-body">
    <div class="viewer-stage"><div class="vpins"></div></div>
    <div class="viewer-badge" aria-hidden="true"></div>${ch ? `
    <select class="viewer-ver" aria-label="Version on screen" hidden></select>
    <aside class="iter" id="iter-panel" aria-labelledby="iter-h">
      <div class="iter-head"><h2 id="iter-h">Changes</h2><span class="iter-sub"></span><button type="button" class="ibtn quiet iter-close" data-viewer="changes" aria-label="Hide changes">${icon("x")}</button></div>
      <div class="iter-log" role="log" aria-label="Versions of this redesign"></div>
      <form class="iter-compose">
        <p class="iter-base"></p>
        <ol class="iter-pins"></ol>
        <div class="iter-box">
          <div class="iter-refs"></div>
          <textarea name="ask" rows="2" maxlength="2000" writingsuggestions="false" autocorrect="off" placeholder="Describe a change, or pin a spot on the image" aria-label="Describe a change"></textarea>
          <div class="iter-tools">
            <button type="button" class="itool" data-iter="pin" aria-pressed="false" title="Pin a note to a spot on the image">${icon("pin")}<span>Pin</span></button>
            <label class="itool" title="Add up to 3 reference photos">${icon("image")}<span>Photo</span><input type="file" accept="image/*" multiple hidden></label>
            <button type="submit" class="isend" aria-label="Make this change">${icon("arrowUp")}</button>
          </div>
        </div>
        <p class="iter-status" role="status" aria-live="polite"></p>
      </form>
    </aside>` : ""}
  </div>
</dialog>

${back ? `${mobileTabsHtml("reports")}\n<script>${mobileTabsScript}</script>\n` : ""}<script>${motionScript}</script>${input.changes ? `\n<script src="/assets/pull-refresh.js"></script>` : ""}
<script>
(() => {
  const motion = window.whimMotion;
  const STATUS = ${JSON.stringify(Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, { label: v.label, meaning: v.meaning, icon: icon(v.icon) }])))};

  /* Scope tabs: WAI-ARIA tabs with automatic activation */
  function syncScopeControls() {
    const selected = [...document.querySelectorAll('.room [role="tab"][aria-selected="true"]')];
    document.querySelectorAll("[data-all-tier]").forEach((b) => b.setAttribute("aria-pressed", String(selected.length > 0 && selected.every((t) => t.dataset.tier === b.dataset.allTier))));
  }
  function selectTier(room, tier, focus) {
    const tabs = [...document.querySelectorAll('[role="tab"][data-room="' + room + '"]')];
    if (!tabs.some((t) => t.dataset.tier === tier)) return;
    tabs.forEach((t) => {
      const on = t.dataset.tier === tier;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    document.querySelectorAll('[data-panel^="' + room + ':"]').forEach((p) => (p.hidden = p.dataset.panel !== room + ":" + tier));
    syncScopeControls();
  }
  function setAll(tier) {
    document.querySelectorAll(".tabs").forEach((list) => {
      const first = list.querySelector('[role="tab"]');
      if (first) selectTier(first.dataset.room, tier, false);
    });
    syncScopeControls();
    const url = new URL(location.href);
    url.searchParams.set("scope", tier);
    history.replaceState(null, "", url);
  }
  document.addEventListener("keydown", (e) => {
    const tab = e.target.closest?.('[role="tab"]');
    if (!tab) return;
    const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(tab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    selectTier(t.dataset.room, t.dataset.tier, true);
  });
  const initial = new URL(location.href).searchParams.get("scope");
  if (initial) setAll(initial);
  else syncScopeControls();

  const toolbar = document.querySelector(".toolbar");
  const byRoom = document.querySelector(".by-room");
  function updateToolbar() {
    if (!toolbar || !byRoom) return;
    const main = document.getElementById("content"), rect = main.getBoundingClientRect(), css = getComputedStyle(main);
    const left = parseFloat(css.paddingLeft), right = parseFloat(css.paddingRight);
    toolbar.style.setProperty("--toolbar-left", (rect.left + left) + "px");
    toolbar.style.setProperty("--toolbar-width", (rect.width - left - right) + "px");
    const visible = byRoom.getBoundingClientRect().bottom <= 0;
    toolbar.hidden = !visible;
    if (!visible) toolbar.querySelector("details").open = false;
    if (visible) document.documentElement.style.setProperty("--toolbar-height", toolbar.getBoundingClientRect().height + "px");
  }
  let toolbarFrame = null;
  function scheduleToolbar() {
    if (toolbarFrame !== null) return;
    toolbarFrame = requestAnimationFrame(() => { toolbarFrame = null; updateToolbar(); });
  }
  window.addEventListener("scroll", scheduleToolbar, { passive:true });
  window.addEventListener("resize", scheduleToolbar);
  window.addEventListener("pageshow", scheduleToolbar);
  if (byRoom) new ResizeObserver(scheduleToolbar).observe(byRoom);
  if (toolbar) new ResizeObserver(scheduleToolbar).observe(toolbar);
  updateToolbar();
  const roomPicker = document.getElementById("room-jump");
  function positionRoomMenu() {
    if (!roomPicker?.open) return;
    const rect = roomPicker.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + (viewport?.height ?? innerHeight);
    const below = bottom - rect.bottom - 16, above = rect.top - top - 16;
    const opensAbove = below < 240 && above > below;
    roomPicker.dataset.placement = opensAbove ? "above" : "below";
    roomPicker.querySelector(".room-menu").style.maxHeight = Math.max(44, Math.min(360, opensAbove ? above : below)) + "px";
  }
  roomPicker?.addEventListener("toggle", positionRoomMenu);
  window.addEventListener("resize", positionRoomMenu);
  window.addEventListener("scroll", positionRoomMenu, { passive:true });
  roomPicker?.addEventListener("click", (e) => {
    const choice = e.target.closest("[data-jump-room]");
    if (!choice) return;
    const id = choice.dataset.jumpRoom;
    roomPicker.open = false;
    const room = document.getElementById(id);
    if (room) motion.scroll(scrollY + room.getBoundingClientRect().top - parseFloat(getComputedStyle(room).scrollMarginTop || 0));
    const h = document.getElementById(id + "-h");
    h?.setAttribute("tabindex", "-1");
    h?.focus({ preventScroll: true });
  });
  roomPicker?.addEventListener("keydown", (e) => {
    const options = [...roomPicker.querySelectorAll("[data-jump-room]")];
    const current = options.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault(); roomPicker.open = false; roomPicker.querySelector("summary").focus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault(); roomPicker.open = true;
      const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 :
        current < 0 ? (e.key === "ArrowUp" ? options.length - 1 : 0) :
        (current + (e.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
      options[next]?.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (roomPicker && !roomPicker.contains(e.target)) roomPicker.open = false;
  });
  roomPicker?.addEventListener("focusout", (e) => {
    if (!roomPicker.contains(e.relatedTarget)) roomPicker.open = false;
  });

  /* Viewer */
  const dialog = document.querySelector("dialog.viewer");
  const stage = dialog.querySelector(".viewer-stage");
  // The viewer image element is created on first open, so the closed dialog holds no empty image.
  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  const finishImage = () => {
    img.style.visibility = "";
    stage.style.backgroundImage = "";
    stage.setAttribute("aria-busy", "false");
  };
  img.addEventListener("error", () => {
    // Keep the preview visible when the original cannot be fetched.
    stage.setAttribute("aria-busy", "false");
  });
  const tabsEl = dialog.querySelector(".viewer-tabs");
  const bar = dialog.querySelector(".viewer-bar");
  const badge = dialog.querySelector(".viewer-badge");
  function updateBadge() {
    const version = items[index].dataset.label.split(" · ").pop();
    const original = !items[index].dataset.status;
    badge.classList.toggle("original", original);
    badge.innerHTML = '<span class="dots">' + items.map((_, n) => n === index ? '<i class="on"></i>' : "<i></i>").join("") + "</span>" + (original ? "Original" : version);
    badge.classList.remove("pop");
    void badge.offsetWidth; // restart the pop on every flip
    badge.classList.add("pop");
  }
  const title = dialog.querySelector("#viewer-title");
  const statusEl = dialog.querySelector("#viewer-status");
  const fitBtn = dialog.querySelector('[data-viewer="fit"]');
  const actualBtn = dialog.querySelector('[data-viewer="actual"]');
  let items = [], index = 0, trigger = null, comparedRedesign = 1;
  // Set by the change panel when the app serves this report.
  let iterShow = null, iterPinClick = null;

  function centerImage() {
    stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
    stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
  }
  img.addEventListener("load", () => {
    finishImage();
    if (stage.classList.contains("actual")) centerImage();
  });
  new ResizeObserver(() => {
    if (stage.classList.contains("actual")) centerImage();
  }).observe(stage);

  function loadViewerImage(source, preview) {
    stage.style.backgroundImage = preview ? "url(" + JSON.stringify(preview) + ")" : "";
    img.style.visibility = "hidden";
    stage.setAttribute("aria-busy", "true");
    img.src = source;
    if (img.complete && img.naturalWidth) finishImage();
  }

  function show(i, keepZoom) {
    resetInteraction();
    index = (i + items.length) % items.length;
    const item = items[index];
    if (item.dataset.status) comparedRedesign = index;
    if (!img.isConnected) stage.append(img);
    const preview = item.querySelector("img");
    loadViewerImage(item.dataset.src || preview.src, preview?.currentSrc || preview?.src);
    img.alt = item.dataset.label;
    title.textContent = item.dataset.label;
    const s = STATUS[item.dataset.status];
    statusEl.innerHTML = s
      ? '<span class="status s-' + item.dataset.status + '">' + s.icon + "<span>" + s.label + '</span><span class="status-meaning">' + s.meaning + "</span></span>"
      : '<span class="viewer-plain">As photographed for the listing</span>';
    tabsEl.querySelectorAll("button").forEach((b, n) => b.setAttribute("aria-pressed", String(n === index)));
    updateBadge();
    if (!keepZoom) setZoom(false);
    else if (img.complete) centerImage();
    iterShow?.(item);
    prefetchNearby();
  }
  function setZoom(actual, point) {
    resetInteraction();
    const before = img.getBoundingClientRect();
    const ratio = point && before.width && before.height ? {
      x: Math.max(0, Math.min(1, (point.x - before.left) / before.width)),
      y: Math.max(0, Math.min(1, (point.y - before.top) / before.height))
    } : null;
    resetZoom(false);
    stage.classList.toggle("actual", actual);
    fitBtn.setAttribute("aria-pressed", String(!actual));
    actualBtn.setAttribute("aria-pressed", String(actual));
    if (actual && ratio) {
      const after = img.getBoundingClientRect(), viewport = stage.getBoundingClientRect();
      stage.scrollLeft += after.left - viewport.left + after.width * ratio.x - stage.clientWidth / 2;
      stage.scrollTop += after.top - viewport.top + after.height * ratio.y - stage.clientHeight / 2;
    } else if (actual) centerImage();
    else { stage.scrollLeft = 0; stage.scrollTop = 0; }
  }
  document.addEventListener("click", (e) => {
    const closeAlbum = e.target.closest("[data-album-close]");
    if (closeAlbum) { const album = closeAlbum.closest(".scope-album"); album.open = false; album.querySelector("summary").focus(); return; }
    const tab = e.target.closest('[role="tab"]');
    if (tab) return selectTier(tab.dataset.room, tab.dataset.tier, false);
    const all = e.target.closest("[data-all-tier]");
    if (all) return setAll(all.dataset.allTier);
    const z = e.target.closest(".zoom");
    if (z) {
      const wasOpen = dialog.open;
      const focusVersion = wasOpen && tabsEl.contains(document.activeElement);
      trigger = z;
      items = [...document.querySelectorAll('.zoom[data-group="' + CSS.escape(z.dataset.group) + '"]')];
      tabsEl.innerHTML = items.map((it, n) => '<button type="button" data-index="' + n + '" aria-pressed="false">' + it.dataset.label.split(" · ").pop().replace("Listing photo", "Listing") + "</button>").join("");
      show(items.indexOf(z), wasOpen && stage.classList.contains("actual"));
      if (!wasOpen) {
        /* The Changes panel starts hidden each time the viewer opens. */
        dialog.classList.add("iter-closed");
        dialog.querySelector(".viewer-iter")?.setAttribute("aria-pressed", "false");
        dialog.showModal();
        dialog.focus({ preventScroll: true });
        // A history entry, so the phone's back gesture closes the viewer instead of leaving the report.
        history.pushState({ ...history.state, whimViewer: true }, "");
      } else if (focusVersion) tabsEl.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
      return;
    }
    const vt = e.target.closest(".viewer-tabs button");
    if (vt) return show(Number(vt.dataset.index), true);
    if (e.target.closest('[data-viewer="close"]')) return dialog.close();
    if (e.target.closest('[data-viewer="fit"]')) return setZoom(false);
    if (e.target.closest('[data-viewer="actual"]')) return setZoom(true);
  });
  function adjacentPhoto(direction) {
    const album = items[index]?.closest(".album-grid");
    const photos = [...(album ? album.querySelectorAll(".zoom") : document.querySelectorAll(".room .zoom"))];
    const groups = [...new Set(photos.map((z) => z.dataset.group))];
    const g = groups.indexOf(items[index]?.dataset.group);
    if (g < 0 || groups.length < 2) return null;
    const version = items[index].dataset.label.split(" · ").pop();
    const nextGroup = groups[(g + direction + groups.length) % groups.length];
    const next = photos.filter((z) => z.dataset.group === nextGroup);
    return next.find((z) => z.dataset.label.endsWith(" · " + version)) ?? next[0];
  }
  function nextPhoto(direction) { adjacentPhoto(direction)?.click(); }
  const mobileViewer = matchMedia("(max-width: 860px), (hover: none) and (pointer: coarse) and (orientation: landscape) and (max-height: 600px)");
  let drag = null, holdTimer = null, springFrame = null, reel = null, split = null;
  const pointers = new Map(); // pointerId -> latest position, for pinch zoom
  // Phone pinch zoom: a transform on the image that survives version flips but not room changes.
  let zoom = { s: 1, x: 0, y: 0 }, pinch = null;
  const applyZoom = () => { img.style.transform = zoom.s === 1 ? "" : "translate(" + zoom.x + "px, " + zoom.y + "px) scale(" + zoom.s + ")"; };
  function resetZoom(animate) {
    zoom = { s: 1, x: 0, y: 0 };
    if (animate && !motion.reduce.matches) {
      img.style.transition = "transform .22s cubic-bezier(.22,1,.36,1)";
      setTimeout(() => { img.style.transition = ""; }, 240);
    }
    applyZoom();
  }
  const imageSource = (item) => item?.dataset.src || item?.querySelector("img")?.src;
  const previewSource = (item) => {
    const source = imageSource(item), warmed = warmedImages.get(source);
    return warmed?.complete && warmed.naturalWidth ? source : item?.querySelector("img")?.currentSrc || item?.querySelector("img")?.src || source;
  };
  // Warm the likely next interactions, with bounded concurrency and cache size. Every version of
  // the open room is warmed and decoded so flipping between them is instant.
  const warmedImages = new Map();
  let prefetchQueue = [], prefetchActive = 0;
  function prefetchImage(source) {
    if (!source || source.startsWith("data:") || warmedImages.has(source) || prefetchQueue.includes(source)) return;
    if (prefetchQueue.length >= 12) prefetchQueue.pop();
    prefetchQueue.push(source);
    drainPrefetch();
  }
  function drainPrefetch() {
    while (prefetchActive < 3 && prefetchQueue.length) {
      const source = prefetchQueue.shift();
      if (warmedImages.has(source)) continue;
      const image = new Image();
      image.decoding = "async";
      image.fetchPriority = "low";
      warmedImages.set(source, image);
      prefetchActive++;
      const done = (failed) => {
        if (failed) warmedImages.delete(source);
        prefetchActive--;
        const keep = new Set(items.map(imageSource));
        while (warmedImages.size > 16) {
          const oldest = [...warmedImages].find(([key, candidate]) => candidate.complete && !keep.has(key));
          if (!oldest) break;
          warmedImages.delete(oldest[0]);
        }
        drainPrefetch();
      };
      image.src = source;
      // decode() also waits for the load; a decoded image paints on the first frame it is shown.
      image.decode().then(() => done(false), () => done(!(image.complete && image.naturalWidth)));
    }
  }
  function prefetchNearby() {
    prefetchQueue = [];
    // This room's versions first, in tap order (the next one up first), then the split comparison.
    for (let n = 1; n < items.length; n++) prefetchImage(imageSource(items[(index + n) % items.length]));
    prefetchImage(imageSource(items[comparisonIndex()]));
    // On metered connections, warm this room only.
    if (navigator.connection?.saveData) return;
    for (const direction of [1, -1]) {
      const neighbor = adjacentPhoto(direction);
      prefetchImage(imageSource(neighbor));
      prefetchImage(previewSource(neighbor));
    }
  }
  function prefetchIntent(e) {
    const target = e.target.closest?.(".zoom");
    if (target) prefetchImage(imageSource(target));
  }
  document.addEventListener("pointerover", prefetchIntent, { passive:true });
  document.addEventListener("focusin", prefetchIntent);
  document.addEventListener("pointerdown", prefetchIntent, { passive:true });
  function resetInteraction() {
    clearTimeout(holdTimer); holdTimer = null;
    cancelAnimationFrame(springFrame); springFrame = null;
    reel?.before.remove(); reel?.after.remove(); reel = null;
    split?.layer.remove(); split?.divider.remove(); split = null;
    applyZoom();
    stage.style.backgroundPosition = "";
    dialog.style.backgroundColor = "";
    dialog.classList.remove("dismissing");
    bar.style.opacity = badge.style.opacity = "";
    stage.classList.remove("reeling", "comparing", "dragging");
    drag = null;
  }
  // Critically damped-ish spring in pixels: velocity carries through the release.
  function spring(from, to, velocity, update, finish) {
    cancelAnimationFrame(springFrame);
    if (motion.reduce.matches) { update(to); finish(); return; }
    let x = from, v = velocity * 1000, last = performance.now(), started = last;
    function frame(now) {
      const dt = Math.min((now - last) / 1000, .032); last = now;
      v += (-320 * (x - to) - 32 * v) * dt;
      x += v * dt;
      update(x);
      if ((Math.abs(x - to) < .5 && Math.abs(v) < 5) || now - started > 900) {
        springFrame = null; update(to); finish();
      } else springFrame = requestAnimationFrame(frame);
    }
    springFrame = requestAnimationFrame(frame);
  }
  // A short ease-out that carries the photo off screen; closing waits for this, not a spring's long tail.
  function flyOut(from, to, update, finish) {
    cancelAnimationFrame(springFrame);
    if (motion.reduce.matches) { finish(); return; }
    const started = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - started) / 160), eased = 1 - (1 - t) * (1 - t);
      update(from + (to - from) * eased);
      if (t < 1) springFrame = requestAnimationFrame(frame);
      else { springFrame = null; finish(); }
    }
    springFrame = requestAnimationFrame(frame);
  }
  function makeNeighbor(item) {
    const el = document.createElement("div");
    el.className = "viewer-neighbor";
    if (item) el.style.backgroundImage = "url(" + JSON.stringify(previewSource(item)) + ")";
    stage.append(el);
    return el;
  }
  function startReel() {
    const previous = adjacentPhoto(-1), next = adjacentPhoto(1);
    reel = { previous, next, before: makeNeighbor(previous), after: makeNeighbor(next), size: stage.clientWidth, offset: 0 };
    stage.classList.add("reeling");
    moveReel(0);
  }
  // Phones move between rooms sideways, like Photos: the previous room waits on the left.
  function moveReel(x) {
    if (!reel) return;
    reel.offset = x;
    stage.style.backgroundPosition = "calc(50% + " + x + "px) center";
    img.style.transform = "translateX(" + x + "px)";
    reel.before.style.transform = "translateX(" + (x - reel.size) + "px)";
    reel.after.style.transform = "translateX(" + (x + reel.size) + "px)";
  }
  // Pulling the photo up or down closes the viewer; the page shows through as it goes.
  function moveDismiss(y) {
    const progress = Math.min(1, Math.abs(y) / (stage.clientHeight * .6));
    img.style.transform = "translateY(" + y + "px) scale(" + (1 - progress * .15) + ")";
    stage.style.backgroundPosition = "center calc(50% + " + y + "px)";
    dialog.classList.toggle("dismissing", y !== 0);
    dialog.style.backgroundColor = "rgba(15,15,14," + (1 - progress) + ")";
    bar.style.opacity = badge.style.opacity = String(1 - progress);
  }
  function comparisonIndex() {
    const original = items.findIndex((it) => !it.dataset.status);
    return index === original ? (items[comparedRedesign]?.dataset.status ? comparedRedesign : items.findIndex((it) => !!it.dataset.status)) : original;
  }
  function moveSplit(x) {
    if (!split) return;
    split.x = Math.max(0, Math.min(stage.clientWidth, x));
    split.layer.style.clipPath = split.side === "left"
      ? "inset(0 " + (stage.clientWidth - split.x) + "px 0 0)"
      : "inset(0 0 0 " + split.x + "px)";
    split.divider.style.left = split.x + "px";
  }
  // On release the divider springs to whichever side it is past; past the middle shows the other version.
  function settleSplit() {
    const other = split.other;
    const chooseOther = split.side === "left" ? split.x > stage.clientWidth / 2 : split.x < stage.clientWidth / 2;
    const end = (split.side === "left") === chooseOther ? stage.clientWidth : 0;
    spring(split.x, end, 0, moveSplit, () => {
      resetInteraction(); if (chooseOther) show(other, false);
    });
  }
  function startSplit() {
    if (!drag || drag.moved || drag.actual || !mobileViewer.matches) return;
    const other = comparisonIndex();
    if (other < 0 || other === index) return;
    const layer = document.createElement("div"), divider = document.createElement("div");
    layer.className = "viewer-split"; divider.className = "viewer-divider";
    layer.style.backgroundImage = "url(" + JSON.stringify(imageSource(items[other])) + ")";
    // A loaded preview appears immediately while the full image is fetched.
    layer.style.backgroundImage += ", url(" + JSON.stringify(previewSource(items[other])) + ")";
    stage.append(layer, divider);
    const x = Math.max(0, Math.min(stage.clientWidth, drag.x - stage.getBoundingClientRect().left));
    split = { layer, divider, other, x, side: x < stage.clientWidth / 2 ? "left" : "right" };
    drag.axis = "split"; drag.splitStart = split.x;
    stage.classList.add("comparing");
    moveSplit(split.x);
  }
  stage.addEventListener("contextmenu", (e) => { if (mobileViewer.matches) e.preventDefault(); });
  badge.addEventListener("contextmenu", (e) => e.preventDefault());
  // Phones: press and hold the version label to compare in split view; sliding the finger moves
  // the divider. A tap on the label flips the version like a tap on the photo.
  badge.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (drag || pinch || pointers.size) return;
    resetInteraction();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, badge: true, moved: false, actual: false, touch: true };
    badge.setPointerCapture(e.pointerId);
    holdTimer = setTimeout(startSplit, 350);
  });
  badge.addEventListener("pointermove", (e) => {
    if (!drag?.badge || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    if (drag.axis === "split") moveSplit(drag.splitStart + dx);
    else if (Math.hypot(dx, e.clientY - drag.y) > 8) { drag.moved = true; clearTimeout(holdTimer); }
  });
  const endBadge = (e) => {
    if (!drag?.badge || drag.id !== e.pointerId) return;
    clearTimeout(holdTimer);
    const gesture = drag;
    drag = null;
    if (split) { settleSplit(); return; }
    if (e.type === "pointerup" && !gesture.moved && items.length > 1) show(index + 1, true);
  };
  badge.addEventListener("pointerup", endBadge);
  badge.addEventListener("pointercancel", endBadge);
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    resetInteraction();
    if (pointers.size === 2 && e.pointerType === "touch" && mobileViewer.matches && !stage.classList.contains("actual")) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zoom: { ...zoom } };
      stage.setPointerCapture(e.pointerId);
      return;
    }
    if (pointers.size > 1) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop,
      actual: stage.classList.contains("actual"), touch: e.pointerType !== "mouse", moved: false, image: e.target === img,
      axis: null, time: performance.now(), lastX: e.clientX, lastY: e.clientY, velocity: 0, zoomed: zoom.s > 1, zoom: { ...zoom } };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) {
      if (pointers.size < 2) return;
      // Keep the spot between the fingers under the fingers while scaling around the stage center.
      const [a, b] = [...pointers.values()], box = stage.getBoundingClientRect();
      const c = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.max(.8, Math.min(5, pinch.zoom.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
      const qx = (pinch.m.x - c.x - pinch.zoom.x) / pinch.zoom.s, qy = (pinch.m.y - c.y - pinch.zoom.y) / pinch.zoom.s;
      zoom = { s, x: m.x - c.x - s * qx, y: m.y - c.y - s * qy };
      applyZoom();
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (drag.axis === "split") { moveSplit(drag.splitStart + dx); return; }
    if (Math.hypot(dx, dy) > 8) { drag.moved = true; clearTimeout(holdTimer); }
    if (drag.actual && drag.moved) {
      stage.classList.add("dragging");
      stage.scrollLeft = drag.left - dx;
      stage.scrollTop = drag.top - dy;
      return;
    }
    if (!drag.touch || !mobileViewer.matches || !drag.moved) return;
    if (drag.zoomed) {
      zoom = { s: drag.zoom.s, x: drag.zoom.x + dx, y: drag.zoom.y + dy };
      applyZoom();
      return;
    }
    if (!drag.axis) {
      if (Math.abs(dx) > Math.abs(dy) * 1.2) { drag.axis = "rooms"; startReel(); }
      else if (Math.abs(dy) > Math.abs(dx) * 1.2) drag.axis = "dismiss";
    }
    const now = performance.now(), dt = now - drag.time;
    if (drag.axis === "rooms") {
      if (dt > 0) drag.velocity = .65 * ((e.clientX - drag.lastX) / dt) + .35 * drag.velocity;
      const resisted = (!reel.next && dx < 0) || (!reel.previous && dx > 0);
      moveReel(Math.max(-reel.size, Math.min(reel.size, dx * (resisted ? .25 : 1))));
    }
    if (drag.axis === "dismiss") {
      if (dt > 0) drag.velocity = .65 * ((e.clientY - drag.lastY) / dt) + .35 * drag.velocity;
      moveDismiss(dy);
    }
    drag.time = now; drag.lastX = e.clientX; drag.lastY = e.clientY;
  });
  stage.addEventListener("pointerup", (e) => {
    pointers.delete(e.pointerId);
    clearTimeout(holdTimer);
    if (pinch) {
      if (pointers.size < 2) {
        pinch = null; drag = null;
        if (zoom.s < 1.05) resetZoom(true);
      }
      return;
    }
    stage.classList.remove("dragging");
    const gesture = drag;
    drag = null;
    if (!gesture || gesture.id !== e.pointerId) return;
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    if (split) { settleSplit(); return; }
    const velocity = performance.now() - gesture.time < 100 ? Math.max(-3, Math.min(3, gesture.velocity)) : 0;
    if (reel) {
      const projected = reel.offset + velocity * 180;
      const direction = projected < 0 ? 1 : -1;
      const target = direction === 1 ? reel.next : reel.previous;
      const advance = target && Math.abs(projected) > reel.size * .22;
      spring(reel.offset, advance ? -direction * reel.size : 0, velocity, moveReel, () => {
        resetInteraction(); if (advance) target.click();
      });
      return;
    }
    if (gesture.axis === "dismiss") {
      const projected = dy + velocity * 180;
      if (Math.abs(projected) > 110) flyOut(dy, Math.sign(projected) * stage.clientHeight, moveDismiss, () => dialog.close());
      else spring(dy, 0, velocity, moveDismiss, resetInteraction);
      return;
    }
    if (gesture.zoomed && gesture.moved) return;
    // Phones: a tap on the right half flips to the next version of this photo (listing photo, then
    // each redesign), a tap on the left half to the previous one.
    if (!gesture.moved && gesture.touch && mobileViewer.matches) {
      const box = stage.getBoundingClientRect();
      if (items.length > 1) show(index + (e.clientX < box.left + box.width / 2 ? -1 : 1), true);
      return;
    }
    if (gesture.touch && !gesture.actual && Math.max(Math.abs(dx), Math.abs(dy)) >= 45) {
      if (Math.abs(dx) > Math.abs(dy) * 1.2) nextPhoto(dx < 0 ? 1 : -1);
      else if (Math.abs(dy) > Math.abs(dx) * 1.2) dialog.close();
      return;
    }
    if (!gesture.moved && !mobileViewer.matches && iterPinClick?.(e)) return;
    if (!gesture.moved && gesture.image) setZoom(!stage.classList.contains("actual"), { x: e.clientX, y: e.clientY });
  });
  const cancelGesture = (e) => {
    pointers.delete(e.pointerId);
    if (pinch && pointers.size < 2) { pinch = null; if (zoom.s < 1.05) resetZoom(true); }
    // Normal release also loses capture; let the settling spring finish.
    if (drag?.id === e.pointerId) resetInteraction();
  };
  stage.addEventListener("pointercancel", cancelGesture);
  stage.addEventListener("lostpointercapture", cancelGesture);
  mobileViewer.addEventListener("change", resetInteraction);
  window.addEventListener("resize", () => { if (dialog.open) { resetInteraction(); pointers.clear(); } });
  dialog.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); show(index + 1, true); }
    if (e.key === "ArrowLeft") { e.preventDefault(); show(index - 1, true); }
    if (e.key === "z" || e.key === "Z") { e.preventDefault(); setZoom(!stage.classList.contains("actual")); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); nextPhoto(e.key === "ArrowDown" ? 1 : -1); }
  });
  let closingFromHistory = false;
  window.addEventListener("popstate", () => {
    if (!dialog.open) return;
    closingFromHistory = true;
    dialog.close();
  });
  dialog.addEventListener("close", () => {
    resetInteraction(); pointers.clear(); prefetchQueue = []; img.remove(); trigger?.focus({ preventScroll: true });
    if (!closingFromHistory && history.state?.whimViewer) history.back();
    closingFromHistory = false;
  });

  /* Return to the exact picker state when that's where we came from. */
  try {
    const ref = document.referrer && new URL(document.referrer);
    if (ref && ref.origin === location.origin && ref.pathname === "/") {
      document.querySelectorAll("a[data-back]").forEach((a) => {
        if (new URL(a.href).searchParams.get("listing") === ref.searchParams.get("listing")) a.href = ref.href;
      });
    }
  } catch {}

  /* Download menus: each button opens its Summary / Full scope choices. */
  const dlButtons = [...document.querySelectorAll(".dl > button")];
  function positionDownloadMenu(button) {
    const menu = document.getElementById(button.getAttribute("aria-controls"));
    menu.style.translate = "";
    const rect = menu.getBoundingClientRect();
    const shift = rect.left < 16 ? 16 - rect.left : rect.right > innerWidth - 16 ? innerWidth - 16 - rect.right : 0;
    menu.style.translate = shift + "px 0";
    const anchor = button.getBoundingClientRect();
    menu.style.setProperty("--menu-origin", (anchor.left + anchor.width / 2 - rect.left - shift) + "px");
  }
  window.addEventListener("resize", () => dlButtons.forEach((b) => { if (b.getAttribute("aria-expanded") === "true") positionDownloadMenu(b); }));
  const closeMenus = (except) => dlButtons.forEach((b) => {
    if (b === except) return;
    b.setAttribute("aria-expanded", "false");
    document.getElementById(b.getAttribute("aria-controls")).hidden = true;
  });
  dlButtons.forEach((b) => b.addEventListener("click", () => {
    const open = b.getAttribute("aria-expanded") !== "true";
    closeMenus(b);
    b.setAttribute("aria-expanded", String(open));
    const menu = document.getElementById(b.getAttribute("aria-controls"));
    menu.hidden = !open;
    if (open) { positionDownloadMenu(b); menu.querySelector("a").focus(); }
  }));
  document.addEventListener("click", (e) => { if (!e.target.closest(".dl")) closeMenus(); });
  document.addEventListener("keydown", (e) => {
    const open = dlButtons.find((b) => b.getAttribute("aria-expanded") === "true");
    if (!open) return;
    const menu = document.getElementById(open.getAttribute("aria-controls"));
    if (e.key === "Escape") { closeMenus(); open.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const links = [...menu.querySelectorAll("a")], i = links.indexOf(document.activeElement);
      links[(i + (e.key === "ArrowDown" ? 1 : links.length - 1)) % links.length].focus();
    }
  });
  document.addEventListener("focusin", (e) => { if (!e.target.closest(".dl")) closeMenus(); });

  /* Downloads: fetch first so the page can say it's working (a long report takes a few seconds). */
  const shareStatus = document.querySelector(".share-status");
  document.querySelectorAll("a[data-download]").forEach((link) => link.addEventListener("click", async (e) => {
    e.preventDefault();
    if (link.getAttribute("aria-busy") === "true") return;
    const kind = link.dataset.download;
    const button = link.closest(".dl")?.querySelector("button");
    closeMenus();
    button?.focus();
    link.setAttribute("aria-busy", "true");
    button?.setAttribute("aria-busy", "true");
    shareStatus.textContent = "Preparing the " + kind + "…";
    try {
      const res = await fetch(link.href);
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "HTTP " + res.status);
      const name = /filename[*]=UTF-8''([^;]+)/.exec(res.headers.get("content-disposition") || "")?.[1];
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name ? decodeURIComponent(name) : "report" });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      shareStatus.textContent = kind[0].toUpperCase() + kind.slice(1) + " downloaded.";
    } catch (err) {
      shareStatus.textContent = "Couldn't make the " + kind + ": " + err.message;
    } finally {
      link.removeAttribute("aria-busy");
      button?.removeAttribute("aria-busy");
    }
  }));

  const toTop = document.querySelector(".to-top");
  let ticking = false;
  addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const on = scrollY > 600;
      toTop.classList.toggle("show", on);
      toTop.tabIndex = on ? 0 : -1;
      ticking = false;
    });
  }, { passive: true });
  toTop.addEventListener("click", () => {
    motion.scroll(0);
    document.getElementById("top").focus({ preventScroll: true });
  });

${iterData ? `  const ITER = ${JSON.stringify(iterData).replace(/</g, "\\u003c")};
  ${ITER_SCRIPT}` : ""}
})();
</script>
</body>
</html>
`;
}

import { motionScript } from "./motion.js";
import { planCost, type ChangePlan, type CostRange } from "./redesign/plan.js";
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
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  pin: '<path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11Z"/><circle cx="12" cy="10" r="2.2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  note: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/>',
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
  const log = panel.querySelector(".iter-log"), form = panel.querySelector(".iter-compose"), empty = panel.querySelector(".iter-empty"), sub = panel.querySelector(".iter-sub");
  const pinsEl = form.querySelector(".iter-pins"), refsEl = form.querySelector(".iter-refs"), baseEl = form.querySelector(".iter-base"), statusLine = form.querySelector(".iter-status");
  const askEl = form.elements.ask, notesEl = form.elements.notes, fileEl = form.querySelector('input[type="file"]');
  const pinTool = form.querySelector('[data-iter="pin"]'), ctxTool = form.querySelector('[data-iter="context"]'), sendBtn = form.querySelector(".isend");
  const vpins = stage.querySelector(".vpins");
  let file = ITER.file, ctx = null, viewed = "v1", pinMode = false, dirty = false, busy = false, polling = false;
  const drafts = {};
  const key = () => ctx.room + ":" + ctx.tier;
  const draft = () => (drafts[key()] ||= { pins: [], refs: [], ask: "", notes: "", showNotes: false });
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
    log.hidden = form.hidden = !on;
    empty.hidden = on;
    sub.textContent = on ? original().name + " · " + room().name : "";
    if (!on) { vpins.replaceChildren(); renderVersionMenu(); return; }
    renderLog(true);
    renderDraft();
  }

  /* ---- Composer ---- */
  function renderBase() {
    if (!ctx) return;
    baseEl.textContent = pinMode
      ? "Click the image to pin a note. Esc when done."
      : "Starts from " + (base() === "v1" ? "the original" : label(base()).toLowerCase()) + " on screen.";
  }
  function renderDraft() {
    const d = draft();
    askEl.value = d.ask;
    notesEl.value = d.notes;
    notesEl.hidden = !d.showNotes && !d.notes;
    ctxTool.setAttribute("aria-pressed", String(!notesEl.hidden));
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
  /** Keeps the version dropdown on the image's top-left corner, inside the visible part of the stage. */
  function placeVersionMenu() {
    if (verMenu.hidden || !img.isConnected) return;
    verMenu.style.left = Math.max(stage.offsetLeft + 14, stage.offsetLeft + img.offsetLeft - stage.scrollLeft + 14) + "px";
    verMenu.style.top = Math.max(stage.offsetTop + 14, stage.offsetTop + img.offsetTop - stage.scrollTop + 14) + "px";
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
    img.src = e.image;
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
    if (e.target.closest('[data-iter="context"]')) {
      const d = draft();
      d.showNotes = notesEl.hidden;
      if (!d.showNotes) d.notes = notesEl.value = "";
      renderDraft();
      if (d.showNotes) notesEl.focus();
      return;
    }
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
  notesEl.addEventListener("input", () => { if (ctx) draft().notes = notesEl.value; });
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
      const res = await call("POST", "/versions", { photo: ctx.room, tier: ctx.tier, from: base(), ask, notes: notesEl.hidden ? "" : notesEl.value.trim(), pins, references: d.refs });
      file = res.versions;
      dirty = true;
      drafts[key()] = { pins: [], refs: [], ask: "", notes: "", showNotes: false };
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

  /* Show or hide the panel; it stays that way while the page is open. */
  function setPanel(open) {
    dialog.classList.toggle("iter-closed", !open);
    dialog.querySelectorAll('.viewer-iter').forEach((b) => b.setAttribute("aria-pressed", String(open)));
    if (!open) setPinMode(false);
  }
  dialog.addEventListener("click", (e) => {
    const t = e.target.closest('[data-viewer="changes"]');
    if (!t) return;
    setPanel(dialog.classList.contains("iter-closed"));
    if (!dialog.classList.contains("iter-closed")) askEl.focus({ preventScroll: true });
    else dialog.querySelector(".viewer-iter")?.focus({ preventScroll: true });
  });
  dialog.addEventListener("keydown", (e) => {
    if ((e.key === "c" || e.key === "C") && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest?.("input, textarea, select")) {
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

/** Clickable image that opens the viewer; every image of one room shares a group for ←/→ comparison. */
function zoomable(input: { src: string; alt: string; group: string; label: string; status?: Status; eager?: boolean; room?: string; tier?: Tier; version?: string; edit?: boolean }): string {
  const iter = input.room && input.tier ? ` data-room="${esc(input.room)}" data-tier="${input.tier}" data-version="${esc(input.version ?? ORIGINAL)}"` : "";
  return `<button class="zoom" type="button" data-group="${esc(input.group)}" data-src="${esc(input.src)}" data-label="${esc(input.label)}"${input.status ? ` data-status="${input.status}"` : ""}${iter} aria-label="${input.edit ? "Open and change" : "Enlarge"} ${esc(input.label)}">
      <img src="${esc(input.src)}" alt="${esc(input.alt)}" loading="${input.eager ? "eager" : "lazy"}" decoding="async">
      <span class="zoom-hint${input.edit ? " edit" : ""}" aria-hidden="true">${input.edit ? `${icon("pencil")}<span>Open and change</span>` : icon("expand")}</span>
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
  photos: PhotoResult[];
  profileSummary: string;
  location?: string | null;
  /** Link back to the listing in the picker; omitted for static reports opened from disk. */
  backHref?: string | null;
  run?: { startedAt: string; profileName?: string | null; stopped?: boolean };
  /** PDF download links; only the app can build PDFs, so static reports omit them. */
  pdf?: { summary: string; full: string } | null;
  /** Spot changes; only the app can make them, so static reports omit this. `photos` already has each room's pick applied. */
  changes?: { api: string; originals: PhotoResult[]; versions: VersionsFile } | null;
}): string {
  const photos = input.photos;
  const tiers = [...new Set(photos.flatMap((p) => p.tiers.map((t) => t.tier)))].sort((a, b) => TIER_RANK[a] - TIER_RANK[b]);
  const totals = listingTotals(photos);
  const feature = pickFeature(photos);
  const started = input.run ? new Date(input.run.startedAt) : null;
  const dateText = started ? new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" }).format(started) : null;
  const meta = [
    dateText,
    input.run?.profileName ? `${input.run.profileName} profile` : null,
    input.location?.replace(/\s*\(.*\)$/, ""),
    `${photos.length} ${photos.length === 1 ? "photo" : "photos"}`,
    input.changes?.versions.versions.length ? `${input.changes.versions.versions.length} ${input.changes.versions.versions.length === 1 ? "change" : "changes"}` : null,
  ].filter(Boolean) as string[];
  const back = input.backHref ? { href: esc(input.backHref), label: `Back to ${esc(input.title)}` } : null;
  const docTitle = `${input.title}${started ? ` · ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(started)}` : ""} · Whim`;

  const tally = (tier: Tier) => {
    const list = photos.map((p) => p.tiers.find((t) => t.tier === tier)).filter((t): t is TierResult => !!t);
    const n = (s: Status) => list.filter((t) => t.status === s).length;
    return { total: list.length, verified: n("verified"), review: n("review"), failed: n("failed") + n("error") };
  };

  const overview = feature
    ? `
  <section class="overview card" aria-labelledby="overview-h">
    <h2 id="overview-h">What each scope gets you</h2>
    <p class="lede">The ${esc(roomName(feature).toLowerCase())} at every scope, with the estimate for the whole listing beneath each.</p>
    <div class="plates" style="--cols:${1 + tiers.length}">
      <figure class="plate">
        ${zoomable({ src: feature.original, alt: `Listing photo of the ${roomName(feature).toLowerCase()}`, group: "overview", label: `${roomName(feature)} · Listing photo`, eager: true })}
        <figcaption>
          <span class="plate-title">Listing photo</span>
          <span class="plate-sub">As photographed</span>
        </figcaption>
      </figure>
      ${tiers.map((tier) => {
        const t = feature.tiers.find((x) => x.tier === tier);
        const x = totals.get(tier);
        const c = tally(tier);
        return `
      <figure class="plate">
        ${t?.image
          ? zoomable({ src: t.image, alt: `${tierName(tier)} redesign of the ${roomName(feature).toLowerCase()}`, group: "overview", label: `${roomName(feature)} · ${tierName(tier)}`, status: t.status, eager: true, ...(input.changes ? { room: feature.id, tier, version: input.changes.versions.picks[pickKey(feature.id, tier)] ?? ORIGINAL } : {}) })
          : `<div class="no-image">${t ? STATUS[t.status].label : "Not run"}</div>`}
        <figcaption>
          <span class="plate-title">${tierName(tier)}</span>
          <span class="plate-sub">${TIER_LABELS[tier].blurb}</span>
          ${x ? `<span class="plate-total num">${money(x.range)}</span><span class="plate-sub">Whole listing, ${x.rooms} ${x.rooms === 1 ? "room" : "rooms"}</span>` : ""}
          <span class="plate-tally">${c.verified} of ${c.total} verified${c.review ? ` · ${c.review} to review` : ""}${c.failed ? ` · ${c.failed} changed structure` : ""}</span>
        </figcaption>
      </figure>`;
      }).join("")}
    </div>
    <dl class="legend">
      ${(["verified", "review", "failed"] as const).map((s) => `<div><dt>${statusTag(s)}</dt><dd>${STATUS[s].meaning}</dd></div>`).join("")}
    </dl>
    <details class="fold method">
      <summary>How these estimates work</summary>
      <p>Installed costs (materials and labor) for ${esc(input.location ?? "a typical US metro")} in ${new Date().getFullYear()} dollars, from quantities visible in each photo. Most changes are priced from a unit-cost table (Homewyse national figures, adjusted for local construction wages from BLS, material grade, and 20% contractor overhead and permits); the rest, such as furniture and appliances, are the model's own estimate and say so. Rooms photographed from more than one angle are counted once. These are a ballpark for comparing scopes, not a contractor bid. Structural figures exclude engineering and design fees.</p>
      ${input.profileSummary ? `<p><strong>Taste applied:</strong> ${esc(input.profileSummary)}</p>` : ""}
    </details>
  </section>`
    : "";

  const table = `
  <section class="by-room card" aria-labelledby="byroom-h">
    <details class="fold section-fold">
    <summary><h2 id="byroom-h">By room</h2><span class="fold-meta num">${photos.length} photos · Costs and verification by scope</span></summary>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="byroom-h">
      <table>
        <thead><tr><th scope="col">Room</th>${tiers.map((t) => `<th scope="col">${tierName(t)}</th>`).join("")}</tr></thead>
        <tbody>${photos.map((p) => `
          <tr>
            <th scope="row"><a class="room-link" href="#${p.id}"><img class="room-thumb" src="${esc(p.original)}" alt="" width="64" height="48" loading="lazy" decoding="async"><span>${esc(roomName(p))}</span></a></th>
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

  const rooms = photos.map((p) => {
    const room = roomName(p);
    return `
  <section class="room card" id="${p.id}" aria-labelledby="${p.id}-h">
    <div class="room-head">
      <div class="room-title"><h2 id="${p.id}-h">${esc(room)}</h2><span class="file">${esc(p.basename)}</span></div>
      <div class="tabs" role="tablist" aria-label="Scope for ${esc(room)}">
        ${p.tiers.map((t, i) => `<button role="tab" type="button" id="${p.id}-tab-${t.tier}" data-room="${p.id}" data-tier="${t.tier}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" aria-controls="${p.id}-img-${t.tier} ${p.id}-info-${t.tier}">${tierName(t.tier)}<span class="tab-mark s-${t.status}">${icon(STATUS[t.status].icon)}<span class="sr-only">, ${STATUS[t.status].label}</span></span></button>`).join("")}
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
            ? zoomable({ src: t.image, alt: `${tierName(t.tier)} redesign of the ${room.toLowerCase()}`, group: p.id, label: `${room} · ${tierName(t.tier)}`, status: t.status, room: ch ? p.id : undefined, tier: t.tier, version: v?.id ?? ORIGINAL, edit: !!ch })
            : `<div class="no-image">${STATUS[t.status].label}. ${STATUS[t.status].meaning}.</div>`}
          ${n > 1 && t.image ? versionSelect(p, t.tier, v?.id ?? ORIGINAL) : ""}
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
  :root {
    --bg:#f5f4f1; --surface:#ffffff; --surface-2:#f3f1ed; --text:#1b1a19; --muted:#625e58;
    --line:rgba(27,26,25,.1); --line-strong:rgba(27,26,25,.22);
    --primary:#2f5a44; --primary-text:#ffffff; --primary-soft:#e4eee7; --accent:var(--primary);
    --ok:#3d6a4c; --warn:#8a6216; --bad:#9a3b2f;
    --font:"Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color-scheme:light;
  }
  :root[data-theme="dark"] { color-scheme:dark;
    --bg:#0e0e0d; --surface:#1b1a19; --surface-2:#242321; --text:#ecebe8; --muted:#a39f99;
    --line:rgba(236,235,232,.1); --line-strong:rgba(236,235,232,.22);
    --primary:#8cc3a1; --primary-text:#0d1a12; --primary-soft:#1b2a21; --accent:var(--primary);
    --ok:#8fc49f; --warn:#e0bd78; --bad:#ee9d90;
  }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  html { -webkit-tap-highlight-color:transparent; scrollbar-color:var(--line-strong) transparent; scrollbar-gutter:stable; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 var(--font); caret-color:var(--text); text-wrap:pretty; }
  ::selection { background:color-mix(in srgb, var(--accent) 28%, transparent); }
  a { color:inherit; text-underline-offset:3px; text-decoration-thickness:1px; }
  :focus-visible { outline:2px solid var(--text); outline-offset:2px; border-radius:4px; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .num { font-variant-numeric:tabular-nums; white-space:nowrap; }
  .icon { width:16px; height:16px; flex:none; }
  h1, h2, h3 { margin:0; line-height:1.2; font-weight:600; scroll-margin-top:72px; text-wrap:balance; }
  h1 { font-size:clamp(28px, 4vw, 36px); letter-spacing:-.02em; }
  h2 { font-size:20px; letter-spacing:-.01em; }
  h3 { font-size:15px; }
  h3.sub { font-size:13px; margin:16px 0 4px; color:var(--muted); font-weight:500; }
  main { max-width:1320px; margin:0 auto; padding:28px max(20px, env(safe-area-inset-left)) 120px; }
  .skip { position:absolute; left:-999px; } .skip:focus { left:16px; top:16px; background:var(--surface); padding:8px 12px; z-index:9; }

  .crumb { display:inline-flex; align-items:center; gap:6px; min-height:32px; font-size:14px; color:var(--muted); text-decoration:none; }
  .crumb:hover { color:var(--text); }
  .page-head { margin:8px 0 28px; display:grid; grid-template-columns:minmax(0, 1fr) auto; column-gap:32px; }
  .page-head > * { grid-column:1; }
  .card { background:var(--surface); border:0; border-radius:12px; box-shadow:var(--shadow); padding:28px; }
  @media (max-width: 680px) { .card { padding:18px 16px; border-radius:10px; } }
  .meta { margin:8px 0 0; color:var(--muted); font-size:14px; }
  .meta span + span::before { content:"·"; margin:0 8px; opacity:.6; }
  /* PDF downloads sit at the right, their bottom edge on the title's baseline row (the row is set inline: 2 under a back link, else 1). */
  .page-head > .share { grid-column:2; align-self:end; margin-bottom:4px; }
  .share { position:relative; display:flex; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:8px 10px; max-width:560px; }
  .share-btn { display:inline-flex; align-items:center; gap:8px; min-height:38px; padding:6px 14px 6px 12px; border-radius:8px; border:1px solid var(--line-strong); background:var(--surface); text-decoration:none; color:var(--text); font-size:14px; font-weight:500; white-space:nowrap; }
  .share-btn:hover { border-color:var(--primary); background:var(--primary-soft); }
  .share-btn .icon { color:var(--primary); }
  .share-btn[aria-busy="true"] { opacity:.6; cursor:progress; }
  /* Below the buttons without taking space, so the buttons stay on the baseline while a PDF is prepared. */
  .share-status { position:absolute; top:100%; right:0; margin-top:6px; white-space:nowrap; font-size:13px; color:var(--muted); }
  .share-status:empty { display:none; }
  @media (max-width: 900px) {
    .page-head > .share { grid-column:1; grid-row:auto !important; margin:18px 0 0; justify-content:flex-start; max-width:none; }
    .share-status { position:static; flex-basis:100%; margin:0; white-space:normal; }
  }
  @media (max-width: 680px) { .share-btn { flex:1 1 0; justify-content:center; } }
  .notice { margin:16px 0 0; font-size:14px; color:var(--warn); }

  .status { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:500; white-space:nowrap; }
  .status .icon { width:14px; height:14px; }
  .status-meaning { color:var(--muted); font-weight:400; white-space:normal; }
  .s-verified { color:var(--ok); } .s-review { color:var(--warn); } .s-failed, .s-error { color:var(--bad); } .s-unchanged { color:var(--muted); }
  .status > span:not(.status-meaning) { color:var(--text); }

  /* Overview: image-led plates with gallery-label captions */
  .lede { margin:6px 0 20px; color:var(--muted); max-width:65ch; }
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
  .section-fold > summary { min-height:56px !important; flex-wrap:wrap; gap:4px 14px !important; }
  .section-fold > summary h2 { scroll-margin-top:72px; }
  .fold-meta { color:var(--muted); font-size:13px; font-weight:400; }

  /* Images */
  .zoom { position:relative; display:block; width:100%; padding:0; border:0; background:var(--surface-2); border-radius:3px; overflow:hidden; cursor:zoom-in; aspect-ratio:3 / 2; }
  .zoom img { width:100%; height:100%; object-fit:cover; display:block; --motion:transform .5s var(--ease); }
  .zoom:hover img { transform:scale(1.015); }
  .zoom-hint { position:absolute; right:10px; bottom:10px; width:32px; height:32px; display:grid; place-items:center; border-radius:50%; background:rgba(18,18,17,.55); color:#fff; opacity:0; --motion:opacity .2s; }
  .zoom:hover .zoom-hint, .zoom:focus-visible .zoom-hint { opacity:1; }
  .zoom-hint.edit { width:auto; height:32px; padding:0 12px 0 10px; border-radius:999px; display:flex; gap:6px; align-items:center; font-size:13px; font-weight:500; }
  .zoom-hint.edit .icon { width:15px; height:15px; }
  .no-image { aspect-ratio:3 / 2; display:grid; place-items:center; border-radius:3px; border:1px dashed var(--line-strong); color:var(--muted); font-size:13px; text-align:center; padding:16px; }

  /* By room */
  .by-room { margin-top:20px; padding-top:4px; padding-bottom:4px; }
  .table-scroll { margin-top:8px; overflow-x:auto; }
  table { width:100%; min-width:560px; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; vertical-align:top; padding:12px 16px 12px 0; border-bottom:1px solid var(--line); }
  thead th { font-weight:500; color:var(--muted); font-size:13px; padding-bottom:8px; }
  tbody th { font-weight:500; } tbody th a { text-decoration:none; } tbody th a:hover { text-decoration:underline; }
  .room-link { display:flex; align-items:center; gap:12px; }
  .room-thumb { width:64px; height:48px; object-fit:cover; border-radius:5px; background:var(--surface-2); flex:none; }
  .cell-cost { margin-top:4px; color:var(--muted); font-size:13px; }
  tfoot th, tfoot td { border-bottom:0; padding-top:14px; font-weight:600; font-size:15px; }

  /* Sticky controls */
  .toolbar { position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:10px 16px; align-items:center; margin:20px -20px 0; padding:10px 20px; background:color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter:saturate(1.2) blur(10px); border-bottom:1px solid var(--line); }
  .toolbar .crumb { margin-right:auto; }
  select { font:inherit; font-size:14px; min-height:36px; padding:6px 30px 6px 10px; border-radius:8px; border:1px solid var(--line-strong); color:inherit; background:var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%2366625d' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E") no-repeat right 8px center; appearance:none; }
  .seg { display:inline-flex; padding:3px; border:1px solid var(--line-strong); border-radius:9px; background:var(--surface); }
  .seg button { font:inherit; font-size:13px; font-weight:500; min-height:32px; padding:4px 12px; border:0; border-radius:6px; background:transparent; color:var(--text); cursor:pointer; touch-action:manipulation; }
  .seg button:hover { background:var(--surface-2); }
  .seg button[aria-pressed="true"] { background:var(--primary); color:var(--primary-text); font-weight:600; }
  .seg-label { font-size:13px; color:var(--muted); }

  /* Rooms */
  .room { margin-top:20px; scroll-margin-top:72px; }
  .room-head { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:end; gap:12px 24px; margin-bottom:16px; }
  .room-title { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .file { font-size:13px; color:var(--muted); }
  .tabs { display:inline-flex; padding:3px; border:1px solid var(--line-strong); border-radius:9px; background:var(--surface); }
  .tabs [role="tab"] { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:13px; font-weight:500; min-height:34px; padding:4px 12px; border:0; border-radius:6px; background:transparent; color:var(--text); cursor:pointer; touch-action:manipulation; }
  .tabs [role="tab"]:hover { background:var(--surface-2); }
  .tabs [role="tab"][aria-selected="true"] { background:var(--primary); color:var(--primary-text); font-weight:600; }
  .tabs [aria-selected="true"] .tab-mark { color:inherit; }
  .tab-mark { display:inline-flex; } .tab-mark .icon { width:13px; height:13px; }
  .pair { display:grid; gap:12px; grid-template-columns:repeat(2, minmax(0, 1fr)); }
  .frame { margin:0; min-width:0; }
  /* Version dropdowns sit over the top-left corner of the image, on the report and in the inspector. */
  [role="tabpanel"]:has(> .ver-select) { position:relative; }
  .ver-select { position:absolute; left:10px; top:10px; z-index:2; }
  .ver-select select, .viewer-ver { appearance:none; font:inherit; font-size:13px; font-weight:500; line-height:20px; color:#fff; background:rgba(18,18,17,.62) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 9px center / 14px; -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); border:0; border-radius:8px; padding:5px 30px 5px 11px; cursor:pointer; box-shadow:0 1px 4px rgba(0,0,0,.25); }
  .ver-select select:hover, .viewer-ver:hover { background-color:rgba(18,18,17,.78); }
  .ver-select select:focus-visible, .viewer-ver:focus-visible { outline:2px solid #fff; outline-offset:2px; }
  .ver-select select[disabled] { opacity:.6; cursor:progress; }
  .ver-select option, .viewer-ver option { color:#1b1a19; background:#fff; }
  .frame figcaption, .figcap { margin:8px 0 0; font-size:13px; line-height:20px; color:var(--muted); min-height:20px; }
  /* Spot changes */
  .your-change { margin-top:12px; padding:10px 12px; border-radius:8px; background:var(--surface-2); font-size:14px; }
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

  details.fold { border-bottom:1px solid var(--line); }
  details.fold > summary { display:flex; align-items:center; gap:8px; min-height:44px; padding:0; cursor:pointer; list-style:none; font-weight:500; font-size:14px; }
  details.fold > summary::-webkit-details-marker { display:none; }
  details.fold > summary::after { content:""; margin-left:auto; width:7px; height:7px; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:translateY(var(--fold-y, -2px)) rotate(var(--fold-angle, 45deg)); --motion:transform .2s; }
  details.fold[open] > summary { --fold-y:2px; --fold-angle:-135deg; }
  details.fold[open] { padding-bottom:14px; }
  .count { font-size:12px; color:var(--muted); font-weight:500; padding:1px 7px; border-radius:999px; background:var(--surface-2); }
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
    .pair, .info { grid-template-columns:minmax(0, 1fr); }
    .info-tier, .info-listing { grid-column:1; grid-row:auto; }
    .toolbar .crumb span { display:none; }
    .seg-label, .toolbar .seg { display:none; } /* each room keeps its own scope tabs on small screens */
    .toolbar select { flex:1; }
    .room-head { align-items:start; }
    .tabs { width:100%; } .tabs [role="tab"] { flex:1; justify-content:center; }
  }

  .to-top { position:fixed; right:max(16px, env(safe-area-inset-right)); bottom:max(16px, env(safe-area-inset-bottom)); z-index:6; width:44px; height:44px; display:grid; place-items:center; border-radius:50%; border:1px solid var(--line-strong); background:var(--surface); color:inherit; cursor:pointer; opacity:0; transform:translateY(8px); --motion:opacity .25s, transform .25s var(--ease); pointer-events:none; }
  .to-top.show { opacity:1; transform:none; pointer-events:auto; }

  dialog.viewer { width:100%; height:100dvh; max-width:none; max-height:none; margin:0; padding:0; border:0; background:#0f0f0e; color:#efede9; }
  dialog.viewer::backdrop { background:rgba(0,0,0,.85); }
  dialog.viewer[open] { display:flex; flex-direction:column; }
  dialog.viewer:focus { outline:none; }
  /* Fixed columns and a reserved status line, so switching versions never moves the tabs or the image. */
  .viewer-bar { display:grid; grid-template-columns:minmax(0, 1fr) auto minmax(0, 1fr); gap:8px 16px; align-items:center; padding:0 max(14px, env(safe-area-inset-left)); border-bottom:1px solid rgba(255,255,255,.1); height:66px; flex:none; }
  .viewer-title { display:grid; grid-template-rows:20px 20px; gap:2px; min-width:0; }
  .viewer-body { position:relative; }
  .viewer-ver { position:absolute; left:14px; top:14px; z-index:3; }
  .viewer-title strong, #viewer-status { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:20px; }
  #viewer-status .status { white-space:nowrap; }
  .viewer-plain { color:rgba(239,237,233,.6); font-size:13px; }
  .viewer-actions { justify-self:end; }
  .viewer-title strong { font-weight:500; }
  .viewer-title .status > span:not(.status-meaning) { color:#efede9; }
  .viewer-title .status-meaning { color:rgba(239,237,233,.6); }
  .viewer-title .s-verified { color:#8fc49f; } .viewer-title .s-review { color:#e0bd78; } .viewer-title .s-failed, .viewer-title .s-error { color:#ee9d90; }
  .viewer .seg { background:rgba(255,255,255,.08); } .viewer .seg button { color:rgba(239,237,233,.7); } .viewer .seg button[aria-pressed="true"] { background:#efede9; color:#0f0f0e; }
  .viewer button:focus-visible { outline:2px solid #efede9; outline-offset:-3px; border-radius:6px; }
  .viewer .seg button[aria-pressed="true"]:focus-visible { outline-color:#0f0f0e; }
  .viewer-actions { display:flex; gap:6px; align-items:center; }
  .viewer-shortcuts { position:relative; }
  .viewer-shortcuts > button { display:grid; place-items:center; width:36px; padding:0; }
  .viewer-shortcuts .icon { width:20px; height:20px; }
  .viewer-help { position:absolute; right:0; top:calc(100% + 8px); z-index:2; width:220px; padding:12px; border:1px solid rgba(255,255,255,.22); border-radius:10px; background:#242423; box-shadow:0 8px 24px rgba(0,0,0,.35); font-size:12px; visibility:hidden; opacity:0; }
  .viewer-shortcuts:hover .viewer-help, .viewer-shortcuts:focus-within .viewer-help { visibility:visible; opacity:1; }
  .viewer-help strong { display:block; margin-bottom:8px; font-weight:600; }
  .viewer-help div { display:flex; justify-content:space-between; gap:16px; line-height:24px; }
  .viewer-help kbd { font:inherit; color:#efede9; }
  .viewer-help span { color:rgba(239,237,233,.7); }
  .vbtn { font:inherit; font-size:13px; min-height:36px; padding:4px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.22); background:transparent; color:inherit; cursor:pointer; }
  .vbtn[aria-pressed="true"] { background:#efede9; color:#0f0f0e; }
  .viewer-body { flex:1; min-height:0; display:flex; }
  .viewer-stage { position:relative; flex:1; min-width:0; min-height:0; overflow:auto; overscroll-behavior:contain; display:flex; cursor:zoom-in; }
  .viewer-stage img { flex:none; margin:auto; max-width:100%; max-height:100%; object-fit:contain; display:block; user-select:none; -webkit-user-drag:none; }
  .viewer-stage.actual { cursor:grab; } .viewer-stage.actual.dragging { cursor:grabbing; }
  .viewer-stage.actual img { max-width:none; max-height:none; }
  @media (max-width: 680px) {
    .viewer-bar { grid-template-columns:minmax(0, 1fr) auto auto; grid-template-rows:auto auto; gap:8px 6px; height:auto; padding-block:10px; }
    .viewer-title { grid-column:1 / 3; grid-row:1; }
    .viewer-actions { display:contents; }
    .viewer-actions > [data-viewer="close"] { grid-column:3; grid-row:1; justify-self:end; }
    /* Phones swap the shortcuts button (no keyboard) for an icon-only Changes toggle. */
    .viewer-iter { grid-column:2; grid-row:2; width:36px; padding:0; justify-content:center; }
    .viewer-iter span { display:none; }
    .viewer:has(.viewer-iter) .viewer-shortcuts { display:none; }
    .viewer.iter-closed .viewer-stage { flex:1; aspect-ratio:auto; max-height:none; }
    .viewer-tabs { grid-column:1; grid-row:2; justify-self:start; min-width:0; max-width:100%; overflow:auto; }
    .viewer-tabs button { flex:none; padding-inline:8px; }
    .viewer-shortcuts { grid-column:2; grid-row:2; }
    .viewer-zoom { grid-column:3; grid-row:2; }
    .viewer-help { position:fixed; top:110px; right:14px; }
  }
  /* Change panel: a conversation beside the image, where each reply is a new version. */
  .iter { flex:none; width:380px; display:flex; flex-direction:column; min-height:0; border-left:1px solid rgba(255,255,255,.1); background:#161615; font-size:14px; }
  .iter-head { display:flex; align-items:baseline; gap:10px; padding:14px 16px 10px; }
  .iter-head h2 { font-size:15px; font-weight:600; margin:0; }
  .iter-close { margin-left:auto; align-self:center; min-height:28px; padding:2px 6px; }
  .iter-close .icon { width:16px; height:16px; display:block; }
  .viewer.iter-closed .iter { display:none; }
  .viewer-iter { display:inline-flex; align-items:center; gap:6px; }
  .viewer-iter .icon { width:15px; height:15px; }
  .iter-sub, .iter-empty, .iter-base, .iter-status { color:rgba(239,237,233,.6); font-size:13px; }
  .iter-empty { margin:0; padding:0 16px; }
  .iter-log { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:4px 16px 16px; display:flex; flex-direction:column; gap:14px; }
  .msg p { margin:6px 0 0; line-height:1.45; }
  .msg.user { align-self:flex-end; max-width:88%; padding:10px 12px; border-radius:14px 14px 4px 14px; background:#2a2a28; }
  .msg.user > :first-child { margin-top:0; }
  .msg-from { font-size:12px; color:rgba(239,237,233,.55); }
  .msg.bot p { color:rgba(239,237,233,.78); }
  .msg-shot { display:block; width:100%; aspect-ratio:3 / 2; padding:0; border:2px solid transparent; border-radius:10px; overflow:hidden; background:#232322; cursor:pointer; }
  .msg-shot img { width:100%; height:100%; object-fit:cover; display:block; }
  .msg-shot:hover { border-color:rgba(255,255,255,.3); }
  .msg-shot[aria-pressed="true"] { border-color:#efede9; }
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
  .msg-refs img { width:56px; height:42px; object-fit:cover; border-radius:6px; }
  .msg-warn { color:#e0bd78 !important; font-size:13px; }
  .msg-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:10px; }
  .ibtn { font:inherit; font-size:13px; min-height:32px; padding:4px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.22); background:transparent; color:inherit; cursor:pointer; }
  .ibtn:hover { background:rgba(255,255,255,.08); }
  .ibtn.quiet { border-color:transparent; color:rgba(239,237,233,.6); }
  .ibtn[disabled] { opacity:.5; cursor:progress; }
  .in-report { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:#8fc49f; padding-right:6px; }
  .in-report .icon { width:14px; height:14px; }
  .msg-work { padding:14px; border-radius:10px; background:#232322; display:grid; gap:10px; }
  .msg-step { font-size:13px; color:rgba(239,237,233,.75); }
  .msg-bar { height:4px; border-radius:2px; background:rgba(255,255,255,.12); overflow:hidden; }
  .msg-bar i { display:block; height:100%; width:4%; background:#efede9; transition:width .5s linear; }
  .iter-compose { flex:none; display:grid; gap:8px; padding:12px 16px max(12px, env(safe-area-inset-bottom)); border-top:1px solid rgba(255,255,255,.1); }
  .iter-base, .iter-status { margin:0; }
  .iter-status:empty { display:none; }
  .iter-status.error { color:#ee9d90; }
  .iter-compose textarea, .iter-notes { width:100%; font:inherit; font-size:14px; color:#efede9; background:#232322; border:1px solid rgba(255,255,255,.16); border-radius:12px; padding:10px 12px; resize:none; }
  .iter-notes { border-radius:8px; padding:8px 10px; font-size:13px; }
  .iter-compose textarea:focus, .iter-notes:focus, .iter-pins input:focus { outline:2px solid #efede9; outline-offset:-1px; }
  .iter-compose textarea::placeholder, .iter-notes::placeholder, .iter-pins input::placeholder { color:rgba(239,237,233,.45); }
  .iter-pins { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
  .iter-pins:empty, .iter-refs:empty { display:none; }
  .iter-pins li { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; gap:2px 8px; align-items:center; }
  .iter-pins .pin-n { grid-row:1 / span 2; align-self:start; margin-top:2px; }
  .ipin-item { font-size:12px; color:rgba(239,237,233,.6); }
  .iter-pins input { grid-column:2; width:100%; font:inherit; font-size:13px; color:#efede9; background:#232322; border:1px solid rgba(255,255,255,.16); border-radius:8px; padding:6px 9px; }
  .iter-pins li > button, .iref { grid-column:3; grid-row:1 / span 2; }
  .iter-refs { display:flex; gap:6px; }
  .iref { padding:0; border:0; background:none; border-radius:6px; cursor:pointer; }
  .iref img { width:56px; height:42px; object-fit:cover; border-radius:6px; display:block; }
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
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior:auto !important; } }

  /* Motion + depth system */
  :root { --ease:cubic-bezier(0.22, 1, 0.36, 1); --ease-pop:cubic-bezier(0.35, 1.55, 0.65, 1); --fast:120ms; --base:240ms; --slow:360ms;
    --shadow:0 1px 2px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.02), 0 0 0 0.5px rgba(0,0,0,0.08);
    --shadow-hover:0 2px 4px rgba(0,0,0,0.06), 0 8px 16px rgba(0,0,0,0.04), 0 0 0 0.5px rgba(0,0,0,0.08); }
  :root[data-theme="dark"] { color-scheme:dark;
    --shadow:0 1px 2px rgba(0,0,0,0.3), 0 2px 4px rgba(0,0,0,0.2), 0 0 0 0.5px rgba(255,255,255,0.08);
    --shadow-hover:0 2px 4px rgba(0,0,0,0.35), 0 8px 16px rgba(0,0,0,0.25), 0 0 0 0.5px rgba(255,255,255,0.12); }
  /* Every clickable element presses to 98% on the fast duration. */
  button, .btn, a.nav-link, .tier, .pick, .zoom, summary, [role="tab"] { --motion:transform var(--fast) var(--ease), box-shadow var(--base) var(--ease), background-color var(--base) var(--ease), border-color var(--base) var(--ease), color var(--base) var(--ease), opacity var(--base) var(--ease); }
  button:active:not(:disabled), .btn:active, a.nav-link:active, .tier:active, .pick:active, .zoom:active, summary:active, [role="tab"]:active { transform:scale(0.98); }
  /* Motion fades and lifts tooltip pseudo-elements through these custom properties. */
  [data-tip] { position:relative; --tip-opacity:0; --tip-y:4px; }
  [data-tip]::after { content:attr(data-tip); position:absolute; left:50%; bottom:calc(100% + 6px); translate:-50% var(--tip-y, 4px); opacity:var(--tip-opacity, 0); pointer-events:none; white-space:nowrap; font-size:12px; font-weight:500; padding:4px 8px; border-radius:6px; background:var(--ink, #1b1a19); color:var(--ink-text, #fafaf9); box-shadow:var(--shadow); --motion:opacity var(--base) var(--ease), translate var(--base) var(--ease), filter var(--base) var(--ease);  z-index:40; }
</style>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<main id="content">
  ${back ? `<a class="report-brand" href="/" aria-label="Whim home">${brandLockup}</a>` : `<div class="report-brand" role="img" aria-label="Whim">${brandLockup}</div>`}
  <header class="page-head">
    ${back ? `<a class="crumb" href="${back.href}" data-back>${icon("arrowLeft")}${back.label}</a>` : ""}
    <h1 id="top" tabindex="-1">${esc(input.title)}</h1>
    <p class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</p>
    ${input.pdf
      ? `<div class="share" role="group" aria-label="Download PDF" style="grid-row:${back ? 2 : 1}">
      <a class="share-btn" href="${esc(input.pdf.summary)}" data-pdf="Summary" title="Costs and a before and after for every room" download>${icon("download")}Summary PDF</a>
      <a class="share-btn" href="${esc(input.pdf.full)}" data-pdf="Full scope" title="Every room, scope, and planned change" download>${icon("download")}Full scope PDF</a>
      <span class="share-status" role="status" aria-live="polite"></span>
    </div>`
      : ""}
    ${input.run?.stopped ? `<p class="notice">This run was stopped early, so some rooms or scopes are missing.</p>` : ""}
  </header>
  ${overview}
  ${table}

  <div class="toolbar">
    ${back ? `<a class="crumb" href="${back.href}" data-back aria-label="${back.label}">${icon("arrowLeft")}<span>${esc(input.title)}</span></a>` : ""}
    <label class="sr-only" for="room-jump">Jump to room</label>
    <select id="room-jump"><option value="">Jump to room…</option>${photos.map((p) => `<option value="${p.id}">${esc(roomName(p))}</option>`).join("")}</select>
    ${tiers.length > 1
      ? `<span class="seg-label" id="seg-label">Show in every room</span><div class="seg" role="group" aria-labelledby="seg-label">${tiers.map((t) => `<button type="button" data-all-tier="${t}" aria-pressed="false">${tierName(t)}</button>`).join("")}</div>`
      : ""}
  </div>

  ${rooms}
  ${decide}
</main>

<button class="to-top" type="button" aria-label="Back to top" tabindex="-1">${icon("arrowUp")}</button>

<dialog class="viewer" aria-labelledby="viewer-title" tabindex="-1">
  <div class="viewer-bar">
    <div class="viewer-title"><strong id="viewer-title"></strong><span id="viewer-status"></span></div>
    <div class="seg viewer-tabs" role="group" aria-label="Compare versions"></div>
    <div class="viewer-actions">${ch ? `
      <button class="vbtn viewer-iter" type="button" data-viewer="changes" aria-pressed="true" aria-controls="iter-panel" aria-label="Changes" title="Show or hide changes (C)">${icon("pencil")}<span>Changes</span></button>` : ""}
      <div class="viewer-shortcuts">
        <button class="vbtn" type="button" aria-label="Keyboard shortcuts" aria-describedby="viewer-help">${icon("keyboard")}</button>
        <div class="viewer-help" id="viewer-help" role="tooltip"><strong>Keyboard shortcuts</strong><div><kbd>← →</kbd><span>Switch versions</span></div><div><kbd>↑ ↓</kbd><span>Switch rooms</span></div><div><kbd>Z</kbd><span>Toggle zoom</span></div>${ch ? "<div><kbd>C</kbd><span>Show or hide changes</span></div>" : ""}<div><kbd>Esc</kbd><span>Close viewer</span></div></div>
      </div>
      <div class="seg viewer-zoom" role="group" aria-label="Image size">
        <button type="button" data-viewer="fit" aria-pressed="true">Fit</button>
        <button type="button" data-viewer="actual" aria-pressed="false">100%</button>
      </div>
      <button class="vbtn" type="button" data-viewer="close">Close</button>
    </div>
  </div>
  <div class="viewer-body">
    <div class="viewer-stage"><div class="vpins"></div></div>${ch ? `
    <select class="viewer-ver" aria-label="Version on screen" hidden></select>
    <aside class="iter" id="iter-panel" aria-labelledby="iter-h">
      <div class="iter-head"><h2 id="iter-h">Changes</h2><span class="iter-sub"></span><button type="button" class="ibtn quiet iter-close" data-viewer="changes" aria-label="Hide changes">${icon("x")}</button></div>
      <p class="iter-empty" hidden>The listing photo stays as photographed. Pick a scope above to change its redesign.</p>
      <div class="iter-log" role="log" aria-label="Versions of this redesign"></div>
      <form class="iter-compose">
        <p class="iter-base"></p>
        <ol class="iter-pins"></ol>
        <div class="iter-refs"></div>
        <input class="iter-notes" name="notes" type="text" maxlength="2000" placeholder="Context, like “we're keeping the range”" aria-label="Context" hidden>
        <textarea name="ask" rows="2" maxlength="2000" placeholder="Describe a change, or pin a spot on the image" aria-label="Describe a change"></textarea>
        <div class="iter-tools">
          <button type="button" class="itool" data-iter="pin" aria-pressed="false" title="Pin a note to a spot on the image">${icon("pin")}<span>Pin</span></button>
          <label class="itool" title="Add up to 3 reference photos">${icon("image")}<span>Photo</span><input type="file" accept="image/*" multiple hidden></label>
          <button type="button" class="itool" data-iter="context" aria-pressed="false" title="Add context the plan should know">${icon("note")}<span>Context</span></button>
          <button type="submit" class="isend" aria-label="Make this change">${icon("arrowUp")}</button>
        </div>
        <p class="iter-status" role="status" aria-live="polite"></p>
      </form>
    </aside>` : ""}
  </div>
</dialog>

<script>${motionScript}</script>
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

  document.getElementById("room-jump")?.addEventListener("change", (e) => {
    const id = e.target.value;
    if (!id) return;
    const room = document.getElementById(id);
    if (room) motion.scroll(scrollY + room.getBoundingClientRect().top - parseFloat(getComputedStyle(room).scrollMarginTop || 0));
    const h = document.getElementById(id + "-h");
    h?.setAttribute("tabindex", "-1");
    h?.focus({ preventScroll: true });
    e.target.value = "";
  });

  /* Viewer */
  const dialog = document.querySelector("dialog.viewer");
  const stage = dialog.querySelector(".viewer-stage");
  // The viewer image element is created on first open, so the closed dialog holds no empty image.
  const img = document.createElement("img");
  img.alt = "";
  const tabsEl = dialog.querySelector(".viewer-tabs");
  const title = dialog.querySelector("#viewer-title");
  const statusEl = dialog.querySelector("#viewer-status");
  const fitBtn = dialog.querySelector('[data-viewer="fit"]');
  const actualBtn = dialog.querySelector('[data-viewer="actual"]');
  let items = [], index = 0, trigger = null;
  // Set by the change panel when the app serves this report.
  let iterShow = null, iterPinClick = null;

  function centerImage() {
    stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
    stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
  }
  img.addEventListener("load", () => {
    if (stage.classList.contains("actual")) centerImage();
  });
  new ResizeObserver(() => {
    if (stage.classList.contains("actual")) centerImage();
  }).observe(stage);

  function show(i, keepZoom) {
    index = (i + items.length) % items.length;
    const item = items[index];
    if (!img.isConnected) stage.append(img);
    img.src = item.dataset.src;
    img.alt = item.dataset.label;
    title.textContent = item.dataset.label;
    const s = STATUS[item.dataset.status];
    statusEl.innerHTML = s
      ? '<span class="status s-' + item.dataset.status + '">' + s.icon + "<span>" + s.label + '</span><span class="status-meaning">' + s.meaning + "</span></span>"
      : '<span class="viewer-plain">As photographed for the listing</span>';
    tabsEl.querySelectorAll("button").forEach((b, n) => b.setAttribute("aria-pressed", String(n === index)));
    if (!keepZoom) setZoom(false);
    else if (img.complete) centerImage();
    iterShow?.(item);
  }
  function setZoom(actual, point) {
    const before = img.getBoundingClientRect();
    const ratio = point && before.width && before.height ? {
      x: Math.max(0, Math.min(1, (point.x - before.left) / before.width)),
      y: Math.max(0, Math.min(1, (point.y - before.top) / before.height))
    } : null;
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
        dialog.showModal();
        dialog.focus({ preventScroll: true });
      } else if (focusVersion) tabsEl.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
      return;
    }
    const vt = e.target.closest(".viewer-tabs button");
    if (vt) return show(Number(vt.dataset.index), true);
    if (e.target.closest('[data-viewer="close"]')) return dialog.close();
    if (e.target.closest('[data-viewer="fit"]')) return setZoom(false);
    if (e.target.closest('[data-viewer="actual"]')) return setZoom(true);
  });
  let drag = null, moved = false;
  stage.addEventListener("pointerdown", (e) => {
    moved = false;
    if (!stage.classList.contains("actual")) return;
    drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.classList.add("dragging");
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) moved = true;
    stage.scrollLeft = drag.left - (e.clientX - drag.x);
    stage.scrollTop = drag.top - (e.clientY - drag.y);
  });
  stage.addEventListener("pointerup", (e) => {
    stage.classList.remove("dragging");
    const wasDrag = moved;
    drag = null;
    if (!wasDrag && iterPinClick?.(e)) return;
    if (!wasDrag && e.target === img) setZoom(!stage.classList.contains("actual"), { x: e.clientX, y: e.clientY });
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); show(index + 1, true); }
    if (e.key === "ArrowLeft") { e.preventDefault(); show(index - 1, true); }
    if (e.key === "z" || e.key === "Z") { e.preventDefault(); setZoom(!stage.classList.contains("actual")); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Next/previous room, same version (Listing/Cosmetic/…), so a scope can be scanned room by room.
      e.preventDefault();
      const groups = [...new Set([...document.querySelectorAll(".room .zoom")].map((z) => z.dataset.group))];
      const g = groups.indexOf(items[index]?.dataset.group);
      if (g < 0) return;
      const version = items[index].dataset.label.split(" · ").pop();
      const nextGroup = groups[(g + (e.key === "ArrowDown" ? 1 : -1) + groups.length) % groups.length];
      const next = [...document.querySelectorAll('.zoom[data-group="' + CSS.escape(nextGroup) + '"]')];
      const target = next.find((z) => z.dataset.label.endsWith(" · " + version)) ?? next[0];
      if (target) { trigger = target; target.click(); }
    }
  });
  dialog.addEventListener("close", () => { img.remove(); trigger?.focus({ preventScroll: true }); });

  /* Return to the exact picker state when that's where we came from. */
  try {
    const ref = document.referrer && new URL(document.referrer);
    if (ref && ref.origin === location.origin && ref.pathname === "/") {
      document.querySelectorAll("a[data-back]").forEach((a) => {
        if (new URL(a.href).searchParams.get("listing") === ref.searchParams.get("listing")) a.href = ref.href;
      });
    }
  } catch {}

  /* PDF downloads: fetch first so the button can say it's working (a long report takes a few seconds). */
  const shareStatus = document.querySelector(".share-status");
  document.querySelectorAll("a[data-pdf]").forEach((link) => link.addEventListener("click", async (e) => {
    e.preventDefault();
    if (link.getAttribute("aria-busy") === "true") return;
    const kind = link.dataset.pdf;
    link.setAttribute("aria-busy", "true");
    shareStatus.textContent = "Preparing the " + kind.toLowerCase() + " PDF…";
    try {
      const res = await fetch(link.href);
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "HTTP " + res.status);
      const name = /filename[*]=UTF-8''([^;]+)/.exec(res.headers.get("content-disposition") || "")?.[1];
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name ? decodeURIComponent(name) : "report.pdf" });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      shareStatus.textContent = kind + " PDF downloaded.";
    } catch (err) {
      shareStatus.textContent = "Couldn't make the PDF: " + err.message;
    } finally {
      link.removeAttribute("aria-busy");
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

import { planCost, type ChangePlan, type CostRange } from "./redesign/plan.js";
import type { PhotoResult, TierResult } from "./redesign/run.js";
import { TIER_DEFINITIONS, type Tier } from "./redesign/tiers.js";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

/** "$850", "$12K", "$1.2M": rounded so ranges don't imply false precision. */
export function formatUSD(n: number): string {
  if (n < 1000) return usd.format(Math.round(n / 50) * 50);
  return usdCompact.format(n < 100_000 ? Math.round(n / 500) * 500 : Math.round(n / 5000) * 5000);
}

export function formatRange(r: CostRange): string {
  return `${formatUSD(r.low)}–${formatUSD(r.high)}`;
}

const rangeLabel = (r: CostRange) => `${usd.format(r.low)} to ${usd.format(r.high)}`;

/** Results from before dollar ranges existed only carry a $/$$/$$$ band. */
function changeCost(c: ChangePlan["changes"][number] & { costBand?: string }): string {
  if (Number.isFinite(c.costLow) && Number.isFinite(c.costHigh)) {
    const r = { low: Math.min(c.costLow, c.costHigh), high: Math.max(c.costLow, c.costHigh) };
    return `<span aria-label="${rangeLabel(r)}">${formatRange(r)}</span>${c.costBasis ? `<small class="basis">${esc(c.costBasis)}</small>` : ""}`;
  }
  return esc(c.costBand ?? "–");
}

const baseRoom = (room: string) => room.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();

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

const esc = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STATUS: Record<TierResult["status"], { label: string; icon: string }> = {
  verified: { label: "Verified", icon: "✓" },
  review: { label: "Needs review", icon: "!" },
  failed: { label: "Unverified", icon: "✕" },
  unchanged: { label: "No changes", icon: "–" },
  error: { label: "Error", icon: "✕" },
};

const titleCase = (t: string) => t[0]!.toUpperCase() + t.slice(1);

/** Clickable image that opens the viewer; every image of one photo shares a group for ←/→ comparison. */
function zoomable(input: { src: string; alt: string; group: string; label: string; eager?: boolean }): string {
  return `<button class="zoom" type="button" data-group="${esc(input.group)}" data-src="${esc(input.src)}" data-label="${esc(input.label)}" aria-label="Enlarge: ${esc(input.label)}">
      <img src="${esc(input.src)}" alt="${esc(input.alt)}" loading="${input.eager ? "eager" : "lazy"}" decoding="async">
    </button>`;
}

function badge(status: TierResult["status"]): string {
  return `<span class="badge badge-${status}"><span aria-hidden="true">${STATUS[status].icon}</span> ${STATUS[status].label}</span>`;
}

function tierColumn(photo: PhotoResult, result: TierResult): string {
  const room = photo.room ?? photo.inventory.roomType;
  const flags = result.plan.feasibilityFlags;
  const total = planCost(result.plan);
  const changes = result.plan.changes;
  const summary = [
    `${changes.length} ${changes.length === 1 ? "change" : "changes"}`,
    total ? `<span class="num" aria-label="${rangeLabel(total)}">${formatRange(total)}</span>` : null,
  ].filter(Boolean).join(" · ");

  return `
  <div class="col">
    <header class="col-head">
      <h3>${esc(titleCase(result.tier))}</h3>
      ${badge(result.status)}
    </header>
    ${result.image
      ? zoomable({ src: result.image, alt: `${result.tier} redesign of ${room}`, group: photo.id, label: `${room} · ${titleCase(result.tier)}` })
      : `<div class="no-image">${result.status === "unchanged" ? "No changes needed at this tier" : "No image"}</div>`}
    ${total ? `<p class="col-cost num" aria-label="Estimated ${rangeLabel(total)}">${formatRange(total)}</p>` : ""}
    ${result.reasons.length
      ? `<details class="issues issues-${result.status}"${result.status === "failed" || result.status === "error" ? " open" : ""}>
        <summary><span aria-hidden="true">⚠</span> ${result.reasons.length} verification ${result.reasons.length === 1 ? "note" : "notes"}</summary>
        <ul class="reasons">${result.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      </details>`
      : ""}
    <details class="plan">
      <summary><span>Plan details</span> <span class="muted">${summary}</span></summary>
      <p class="muted">${esc(TIER_DEFINITIONS[result.tier].confidence)}</p>
      ${result.plan.expression ? `<p><strong>Expression:</strong> ${esc(result.plan.expression)}</p>` : ""}
      ${result.plan.architecturalLanguage ? `<p><strong>Language:</strong> ${esc(result.plan.architecturalLanguage)}</p>` : ""}
      ${changes.length
        ? `<ul class="changes">${changes.map((c) => `
          <li>
            <div class="change-head"><strong>${esc(c.element)}</strong><span class="num cost">${changeCost(c)}</span></div>
            <p>${esc(c.proposed)}</p>
            <p class="muted was">Now: ${esc(c.current)}</p>
          </li>`).join("")}
          </ul>
          ${total ? `<p class="total-line"><span>Estimated total, this room</span><span class="num total" aria-label="${rangeLabel(total)}">${formatRange(total)}</span></p>` : ""}`
        : ""}
      ${result.plan.removedWalls.length ? `<p><strong>Walls removed:</strong> ${esc(result.plan.removedWalls.join("; "))}</p>` : ""}
      ${result.plan.beyondScope?.length ? `<div class="flags"><h4>For the full look (beyond this tier)</h4><ul>${result.plan.beyondScope.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}
      ${flags.length ? `<div class="flags"><h4>Check before relying on this</h4><ul>${flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
      ${result.warnings.map((w) => `<p class="muted">${esc(w)}</p>`).join("")}
      <details class="nested">
        <summary>Verification</summary>
        <p>Attempts: ${result.attempts}.${result.editableShare === null ? "" : ` Editable area: ${Math.round(result.editableShare * 100)}% of frame.`}</p>
        ${result.edges.length ? `<ul>${result.edges.map((e) => `<li>${esc(e.kind)} (${esc(e.description)}): ${e.correlation === null ? "flat region, skipped" : `r = ${e.correlation.toFixed(2)}`} ${e.pass ? "pass" : "shifted"}</li>`).join("")}</ul>` : ""}
        ${result.judgement ? `<p>Plan adherence: ${result.judgement.planAdherence}/10.</p>${result.judgement.unplannedChanges.length ? `<p>Unplanned: ${esc(result.judgement.unplannedChanges.join("; "))}</p>` : ""}` : ""}
        ${result.plan.rationale ? `<p class="muted">${esc(result.plan.rationale)}</p>` : ""}
      </details>
    </details>
  </div>`;
}

function originalColumn(photo: PhotoResult): string {
  const room = photo.room ?? photo.inventory.roomType;
  const inv = photo.inventory;
  return `
  <div class="col">
    <header class="col-head"><h3>Original</h3></header>
    ${zoomable({ src: photo.original, alt: `Original listing photo: ${room}`, group: photo.id, label: `${room} · Original`, eager: true })}
    <details class="plan">
      <summary><span>Room notes</span> <span class="muted">${inv.fixed.length} fixed · ${inv.changeable.length} changeable</span></summary>
      ${inv.condition ? `<p>${esc(inv.condition)}</p>` : ""}
      <p class="muted"><strong>Fixed:</strong> ${esc(inv.fixed.map((f) => f.kind.replace(/_/g, " ")).join(", ") || "none")}</p>
      ${inv.uncertainties.length ? `<div class="flags"><h4>Uncertain from this photo</h4><ul>${inv.uncertainties.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></div>` : ""}
    </details>
  </div>`;
}

export function renderReport(input: {
  title: string;
  photos: PhotoResult[];
  profileSummary: string;
  location?: string | null;
  /** Link back to the listing in the picker; omitted for static reports opened from disk. */
  backHref?: string | null;
}): string {
  const back = input.backHref
    ? { href: esc(input.backHref), label: `Back to ${esc(input.title)}` }
    : null;
  const rows = input.photos
    .map(
      (photo) =>
        `<tr><th scope="row"><a href="#${photo.id}">${esc(photo.room ?? photo.inventory.roomType)}</a></th>${photo.tiers
          .map((t) => {
            const cost = planCost(t.plan);
            return `<td>${badge(t.status)}${cost ? `<div class="num cell-cost" aria-label="${rangeLabel(cost)}">${formatRange(cost)}</div>` : ""}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  const tierNames = input.photos[0]?.tiers.map((t) => t.tier) ?? [];
  const totals = listingTotals(input.photos);
  const totalsRow = totals.size
    ? `<tfoot><tr><th scope="row">Whole listing<small class="basis">each room counted once</small></th>${tierNames
        .map((t) => { const x = totals.get(t); return `<td class="num total">${x ? `<span aria-label="${rangeLabel(x.range)}">${formatRange(x.range)}</span><small class="basis">${x.rooms} rooms</small>` : "–"}</td>`; })
        .join("")}</tr></tfoot>`
    : "";
  const cols = 1 + tierNames.length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(input.title)} · Remodel Lens</title>
<style>
  :root { --bg:#f7f6f3; --surface:#fff; --surface-2:#efebe3; --text:#1c1b19; --muted:#5f5b54; --border:rgba(28,27,25,.12); --border-strong:rgba(28,27,25,.28);
    --accent:#3d5a3c; --accent-text:#fff;
    --ok:#1f6f43; --ok-bg:#e3f2e8; --warn:#8a5a00; --warn-bg:#fbefd6; --bad:#a3271d; --bad-bg:#fbe3e0;
    --shadow:0 1px 2px rgba(0,0,0,.05), 0 6px 20px rgba(0,0,0,.05); }
  @media (prefers-color-scheme: dark) { :root { --bg:#151412; --surface:#1f1d1a; --surface-2:#2a2620; --text:#efece6; --muted:#a8a298; --border:rgba(239,236,230,.14); --border-strong:rgba(239,236,230,.3);
    --accent:#9cc49a; --accent-text:#14200f;
    --ok:#7fd3a0; --ok-bg:#163323; --warn:#f0c46a; --warn-bg:#3a2c0e; --bad:#f29a90; --bad-bg:#3d1a16; --shadow:0 1px 2px rgba(0,0,0,.3), 0 6px 20px rgba(0,0,0,.25); } }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  html { -webkit-tap-highlight-color:transparent; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, sans-serif; }
  main { max-width:1640px; margin:0 auto; padding:24px max(16px, env(safe-area-inset-left)) 96px; }
  .skip { position:absolute; left:-999px; } .skip:focus { left:16px; top:16px; background:var(--surface); padding:8px 12px; z-index:5; }
  h1, h2, h3 { line-height:1.2; scroll-margin-top:16px; } h1 { margin:0 0 8px; } h2 { margin:0; font-size:20px; } h3 { margin:0; font-size:15px; }
  a { color:inherit; } :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }
  .muted { color:var(--muted); }
  .num { font-variant-numeric:tabular-nums; white-space:nowrap; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .intro { max-width:80ch; }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:36px; padding:6px 14px; border-radius:999px; border:1px solid var(--border-strong); background:var(--surface); color:inherit; font:inherit; font-weight:550; cursor:pointer; touch-action:manipulation; }
  .btn:hover { border-color:var(--text); }

  .badge { display:inline-flex; gap:4px; align-items:center; font-size:12.5px; font-weight:600; padding:2px 8px; border-radius:999px; white-space:nowrap; }
  .badge-verified { color:var(--ok); background:var(--ok-bg); }
  .badge-review, .badge-unchanged { color:var(--warn); background:var(--warn-bg); }
  .badge-failed, .badge-error { color:var(--bad); background:var(--bad-bg); }

  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; vertical-align:top; padding:8px; border-bottom:1px solid var(--border); }
  .summary-table { max-width:960px; margin:20px 0 8px; }
  .scroll { overflow-x:auto; }
  .basis { display:block; font-size:12px; color:var(--muted); white-space:normal; font-weight:400; }
  .total { font-weight:650; } tfoot th, tfoot td { border-top:2px solid var(--border); border-bottom:0; }
  .cell-cost { margin-top:4px; font-size:13px; }

  .toolbar { position:sticky; top:0; z-index:3; display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:space-between; margin:24px -8px 0; padding:10px 8px; background:color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter:blur(8px); border-bottom:1px solid var(--border); }
  .toolbar nav { display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; flex:1; min-width:0; }
  .toolbar .back { flex:none; text-decoration:none; }
  .crumbs { margin-bottom:12px; font-size:14px; }
  .crumbs a { display:inline-flex; align-items:center; gap:6px; min-height:32px; color:var(--muted); text-decoration:none; }
  .crumbs a:hover { color:var(--text); text-decoration:underline; }
  .toolbar nav a { white-space:nowrap; font-size:13px; padding:4px 10px; border-radius:999px; background:var(--surface-2); text-decoration:none; }

  .photo { margin-top:40px; scroll-margin-top:64px; }
  .photo-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 12px; margin-bottom:12px; }
  .compare { display:grid; gap:14px; grid-template-columns:repeat(${cols}, minmax(0, 1fr)); align-items:start; }
  @media (max-width: 1100px) { .compare { grid-template-columns:repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 600px) { .compare { grid-template-columns:minmax(0, 1fr); } }
  .col { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:12px; box-shadow:var(--shadow); min-width:0; }
  .col-head { display:flex; justify-content:space-between; align-items:center; gap:8px; min-height:28px; margin-bottom:10px; }
  .zoom { display:block; width:100%; padding:0; border:0; background:var(--surface-2); border-radius:8px; overflow:hidden; cursor:zoom-in; aspect-ratio:3 / 2; }
  .zoom img { width:100%; height:100%; object-fit:cover; display:block; transition:transform .2s ease-out; }
  .zoom:hover img { transform:scale(1.02); }
  .no-image { aspect-ratio:3 / 2; display:grid; place-items:center; border-radius:8px; border:1px dashed var(--border-strong); color:var(--muted); font-size:13px; text-align:center; padding:12px; }
  .col-cost { margin:10px 0 0; font-weight:650; font-size:16px; }
  details.issues { margin-top:10px; font-size:13px; } details.issues > summary { cursor:pointer; min-height:28px; font-weight:600; }
  .issues-review > summary { color:var(--warn); } .issues-failed > summary, .issues-error > summary { color:var(--bad); }
  .reasons { font-size:13px; padding-left:18px; margin:6px 0 0; color:var(--muted); }

  details.plan { margin-top:10px; font-size:14px; border-top:1px solid var(--border); padding-top:8px; }
  details.plan > summary { cursor:pointer; min-height:32px; display:flex; flex-wrap:wrap; gap:2px 8px; align-items:center; font-weight:600; list-style-position:inside; }
  details.nested { margin-top:12px; } details.nested > summary { cursor:pointer; min-height:28px; color:var(--muted); }
  .changes { list-style:none; margin:8px 0 0; padding:0; display:grid; gap:10px; }
  .changes li { border-bottom:1px solid var(--border); padding-bottom:10px; }
  .changes p { margin:4px 0 0; } .was { font-size:13px; }
  .change-head { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
  .cost { text-align:right; } .cost .basis { text-align:right; max-width:22ch; margin-left:auto; }
  .total-line { display:flex; justify-content:space-between; gap:8px; margin:10px 0 0; font-weight:600; }
  .flags { border-left:3px solid var(--warn); padding-left:12px; margin-top:12px; } .flags h4 { margin:0 0 4px; font-size:14px; } .flags ul { margin:0; padding-left:18px; }

  .to-top { position:fixed; right:max(16px, env(safe-area-inset-right)); bottom:max(16px, env(safe-area-inset-bottom)); z-index:4; width:48px; height:48px; border-radius:50%; border:1px solid var(--border-strong); background:var(--surface); color:inherit; box-shadow:var(--shadow); font-size:20px; cursor:pointer; opacity:0; transform:translateY(8px); transition:opacity .2s, transform .2s; pointer-events:none; }
  .to-top.show { opacity:1; transform:none; pointer-events:auto; }

  dialog.viewer { width:100vw; height:100dvh; max-width:none; max-height:none; margin:0; padding:0; border:0; background:#0e0d0c; color:#f2efe9; }
  dialog.viewer::backdrop { background:rgba(0,0,0,.85); }
  .viewer-bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:space-between; padding:10px max(12px, env(safe-area-inset-left)); border-bottom:1px solid rgba(255,255,255,.12); }
  .viewer-bar .btn { background:transparent; color:#f2efe9; border-color:rgba(255,255,255,.3); min-height:40px; }
  .viewer-bar .btn[aria-pressed="true"] { background:#f2efe9; color:#0e0d0c; border-color:#f2efe9; }
  .viewer-tabs { display:flex; gap:6px; flex-wrap:wrap; }
  .viewer-stage { height:calc(100dvh - 62px); overflow:auto; overscroll-behavior:contain; display:grid; place-items:center; cursor:zoom-in; }
  /* Explicit viewport math: percentage max-height doesn't resolve inside an auto-sized grid track. */
  .viewer-stage img { max-width:100vw; max-height:calc(100dvh - 62px); object-fit:contain; display:block; user-select:none; -webkit-user-drag:none; }
  .viewer-stage.actual { place-items:start; cursor:grab; }
  .viewer-stage.actual.dragging { cursor:grabbing; }
  .viewer-stage.actual img { max-width:none; max-height:none; }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; scroll-behavior:auto !important; } }
</style>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<main id="content">
  ${back ? `<nav class="crumbs" aria-label="Breadcrumb"><a href="${back.href}" data-back><span aria-hidden="true">←</span> ${back.label}</a></nav>` : ""}
  <h1 id="top" tabindex="-1">${esc(input.title)}</h1>
  <p class="muted intro">${esc(input.profileSummary)}</p>
  <p class="muted intro">Costs are estimated installed ranges (materials and labor) for ${esc(input.location ?? "a typical US metro")} in ${new Date().getFullYear()} dollars, based on quantities visible in each photo. They're an AI ballpark to compare options, not a contractor bid. Get local quotes before deciding. Major-tier figures and images are speculative and exclude engineering and design fees.</p>
  <div class="scroll summary-table"><table>
    <caption class="sr-only">Status and estimated cost by room and tier</caption>
    <thead><tr><th scope="col">Room</th>${tierNames.map((t) => `<th scope="col">${esc(titleCase(t))}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody>
    ${totalsRow}
  </table></div>

  <div class="toolbar">
    ${back ? `<a class="btn back" href="${back.href}" data-back aria-label="${back.label}"><span aria-hidden="true">←</span> ${esc(input.title)}</a>` : ""}
    <nav aria-label="Rooms">${input.photos.map((p) => `<a href="#${p.id}">${esc(p.room ?? p.inventory.roomType)}</a>`).join("")}</nav>
    <div style="display:flex;gap:8px">
      <button class="btn" type="button" data-details="open">Expand all</button>
      <button class="btn" type="button" data-details="close">Collapse all</button>
    </div>
  </div>

  ${input.photos
    .map(
      (photo) => `
  <section class="photo" id="${photo.id}" aria-labelledby="${photo.id}-h">
    <div class="photo-head">
      <h2 id="${photo.id}-h">${esc(photo.room ?? photo.inventory.roomType)}</h2>
      <span class="muted">${esc(photo.basename)}</span>
    </div>
    <div class="compare">
      ${originalColumn(photo)}
      ${photo.tiers.map((t) => tierColumn(photo, t)).join("")}
    </div>
  </section>`,
    )
    .join("")}
</main>

<button class="to-top" type="button" aria-label="Back to top" tabindex="-1">↑</button>

<dialog class="viewer" aria-labelledby="viewer-title">
  <div class="viewer-bar">
    <strong id="viewer-title"></strong>
    <div class="viewer-tabs" role="group" aria-label="Compare versions"></div>
    <div style="display:flex;gap:6px">
      <button class="btn" type="button" data-viewer="zoom" aria-pressed="false">100%</button>
      <button class="btn" type="button" data-viewer="close" aria-label="Close viewer">Close</button>
    </div>
  </div>
  <div class="viewer-stage"><img alt=""></div>
</dialog>

<script>
(() => {
  const dialog = document.querySelector("dialog.viewer");
  const stage = dialog.querySelector(".viewer-stage");
  const img = stage.querySelector("img");
  const tabs = dialog.querySelector(".viewer-tabs");
  const title = dialog.querySelector("#viewer-title");
  const zoomBtn = dialog.querySelector('[data-viewer="zoom"]');
  let items = [], index = 0, trigger = null;

  function show(i, keepZoom) {
    index = (i + items.length) % items.length;
    const item = items[index];
    img.src = item.dataset.src;
    img.alt = item.dataset.label;
    title.textContent = item.dataset.label;
    tabs.querySelectorAll("button").forEach((b, n) => b.setAttribute("aria-pressed", String(n === index)));
    if (!keepZoom) setZoom(false);
  }

  function setZoom(actual, point) {
    const before = stage.getBoundingClientRect();
    const ratio = point ? { x: (point.x - before.left) / before.width, y: (point.y - before.top) / before.height } : null;
    stage.classList.toggle("actual", actual);
    zoomBtn.setAttribute("aria-pressed", String(actual));
    zoomBtn.textContent = actual ? "Fit" : "100%";
    if (actual && ratio) {
      // Keep the clicked spot under the cursor after zooming in.
      stage.scrollLeft = img.naturalWidth * ratio.x - stage.clientWidth / 2;
      stage.scrollTop = img.naturalHeight * ratio.y - stage.clientHeight / 2;
    }
  }

  document.addEventListener("click", (e) => {
    const z = e.target.closest(".zoom");
    if (z) {
      trigger = z;
      items = [...document.querySelectorAll('.zoom[data-group="' + CSS.escape(z.dataset.group) + '"]')];
      tabs.innerHTML = items.map((it, n) => '<button class="btn" type="button" data-index="' + n + '" aria-pressed="false">' + it.dataset.label.split(" · ").pop() + "</button>").join("");
      dialog.showModal();
      show(items.indexOf(z));
      return;
    }
    const tab = e.target.closest(".viewer-tabs button");
    if (tab) return show(Number(tab.dataset.index), true);
    if (e.target.closest('[data-viewer="close"]')) return dialog.close();
    if (e.target.closest('[data-viewer="zoom"]')) return setZoom(!stage.classList.contains("actual"));
    const toggle = e.target.closest("[data-details]");
    if (toggle) document.querySelectorAll("details.plan, details.issues").forEach((d) => (d.open = toggle.dataset.details === "open"));
  });

  // Click the image to zoom in at that point; drag to pan when zoomed.
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
    if (wasDrag) return;
    if (e.target === img) setZoom(!stage.classList.contains("actual"), { x: e.clientX, y: e.clientY });
  });

  dialog.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); show(index + 1, true); }
    if (e.key === "ArrowLeft") { e.preventDefault(); show(index - 1, true); }
    if (e.key === "z" || e.key === "Z") setZoom(!stage.classList.contains("actual"));
  });
  dialog.addEventListener("close", () => { img.removeAttribute("src"); trigger?.focus(); });

  // Return to the exact picker state (collapsed photos, chosen tiers) when that's where we came from.
  try {
    const ref = document.referrer && new URL(document.referrer);
    if (ref && ref.origin === location.origin && ref.pathname === "/") {
      document.querySelectorAll('a[data-back]').forEach((a) => {
        if (new URL(a.href).searchParams.get("listing") === ref.searchParams.get("listing")) a.href = ref.href;
      });
    }
  } catch {}

  const toTop = document.querySelector(".to-top");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
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
    scrollTo({ top: 0, behavior: reduce.matches ? "auto" : "smooth" });
    document.getElementById("top").focus({ preventScroll: true });
  });
})();
</script>
</body>
</html>
`;
}

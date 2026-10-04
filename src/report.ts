import { planCost, type ChangePlan, type CostRange } from "./redesign/plan.js";
import type { PhotoResult, TierResult } from "./redesign/run.js";
import { TIER_LABELS, TIER_RANK, type Tier } from "./redesign/tiers.js";

/* ---------- Formatting ---------- */

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

const esc = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Compact range for the eye, full figures for screen readers (aria-label is unreliable on plain text). */
function money(r: CostRange): string {
  return `<span aria-hidden="true">${formatRange(r)}</span><span class="sr-only">${usd.format(r.low)} to ${usd.format(r.high)}</span>`;
}

const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const baseRoom = (room: string) => room.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
const roomName = (p: PhotoResult) => sentence(p.room ?? p.inventory.roomType);
const tierName = (t: Tier) => TIER_LABELS[t].name;

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

type Status = TierResult["status"];
const STATUS: Record<Status, { label: string; meaning: string; icon: IconName }> = {
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
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
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

/* ---------- Pieces ---------- */

/** Clickable image that opens the viewer; every image of one room shares a group for ←/→ comparison. */
function zoomable(input: { src: string; alt: string; group: string; label: string; status?: Status; eager?: boolean }): string {
  return `<button class="zoom" type="button" data-group="${esc(input.group)}" data-src="${esc(input.src)}" data-label="${esc(input.label)}"${input.status ? ` data-status="${input.status}"` : ""} aria-label="Enlarge ${esc(input.label)}">
      <img src="${esc(input.src)}" alt="${esc(input.alt)}" loading="${input.eager ? "eager" : "lazy"}" decoding="async">
      <span class="zoom-hint" aria-hidden="true">${icon("expand")}</span>
    </button>`;
}

function changeCost(c: ChangePlan["changes"][number] & { costBand?: string }): string {
  if (Number.isFinite(c.costLow) && Number.isFinite(c.costHigh)) {
    return money({ low: Math.min(c.costLow, c.costHigh), high: Math.max(c.costLow, c.costHigh) });
  }
  return esc(c.costBand ?? "–"); // results from before dollar ranges existed
}

function fixedSummary(photo: PhotoResult): string {
  const counts = new Map<string, number>();
  for (const f of photo.inventory.fixed) {
    const k = (KIND[f.kind] ?? sentence(f.kind.replace(/_/g, " "))).toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${n} ${k.endsWith("s") ? k : `${k}s`}` : k)).join(", ");
}

function tierInfo(t: TierResult): string {
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
      ? `<details class="fold">
          <summary>Planned changes <span class="count">${changes.length}</span></summary>
          ${t.plan.expression || t.plan.architecturalLanguage
            ? `<p class="direction">${[t.plan.expression && sentence(t.plan.expression), t.plan.architecturalLanguage].filter(Boolean).map((x) => esc(x!)).join(" · ")}</p>`
            : ""}
          <ul class="changes">${changes.map((c) => `
            <li>
              <div class="change-head"><strong>${esc(sentence(c.element))}</strong><span class="num">${changeCost(c)}</span></div>
              <p>${esc(c.proposed)}</p>
              <p class="was">Now: ${esc(c.current)}</p>
              ${c.costBasis ? `<p class="basis">${esc(c.costBasis)}</p>` : ""}
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

function pickFeature(photos: PhotoResult[]): PhotoResult | null {
  const weight = { verified: 3, review: 2, unchanged: 1, failed: 0, error: 0 } as const;
  const score = (p: PhotoResult) => p.tiers.reduce((s, t) => s + (t.image ? 1 : 0) + weight[t.status], 0);
  const maxCost = (p: PhotoResult) => Math.max(0, ...p.tiers.map((t) => planCost(t.plan)?.high ?? 0));
  return [...photos].sort((a, b) => score(b) - score(a) || maxCost(b) - maxCost(a))[0] ?? null;
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
  ].filter(Boolean) as string[];
  const back = input.backHref ? { href: esc(input.backHref), label: `Back to ${esc(input.title)}` } : null;
  const docTitle = `${input.title}${started ? ` · ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(started)}` : ""} · Remodel Lens`;

  const tally = (tier: Tier) => {
    const list = photos.map((p) => p.tiers.find((t) => t.tier === tier)).filter((t): t is TierResult => !!t);
    const n = (s: Status) => list.filter((t) => t.status === s).length;
    return { total: list.length, verified: n("verified"), review: n("review"), failed: n("failed") + n("error") };
  };

  const overview = feature
    ? `
  <section class="overview" aria-labelledby="overview-h">
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
          ? zoomable({ src: t.image, alt: `${tierName(tier)} redesign of the ${roomName(feature).toLowerCase()}`, group: "overview", label: `${roomName(feature)} · ${tierName(tier)}`, status: t.status, eager: true })
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
      <p>Installed costs (materials and labor) for ${esc(input.location ?? "a typical US metro")} in ${new Date().getFullYear()} dollars, from quantities visible in each photo. Rooms photographed from more than one angle are counted once. These are a ballpark for comparing scopes, not a contractor bid. Structural figures exclude engineering and design fees.</p>
      ${input.profileSummary ? `<p><strong>Taste applied:</strong> ${esc(input.profileSummary)}</p>` : ""}
    </details>
  </section>`
    : "";

  const table = `
  <section class="by-room" aria-labelledby="byroom-h">
    <h2 id="byroom-h">By room</h2>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="byroom-h">
      <table>
        <thead><tr><th scope="col">Room</th>${tiers.map((t) => `<th scope="col">${tierName(t)}</th>`).join("")}</tr></thead>
        <tbody>${photos.map((p) => `
          <tr>
            <th scope="row"><a href="#${p.id}">${esc(roomName(p))}</a></th>
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
  </section>`;

  const rooms = photos.map((p) => {
    const room = roomName(p);
    return `
  <section class="room" id="${p.id}" aria-labelledby="${p.id}-h">
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
        ${p.tiers.map((t, i) => `
        <div role="tabpanel" id="${p.id}-img-${t.tier}" aria-labelledby="${p.id}-tab-${t.tier}" data-panel="${p.id}:${t.tier}"${i === 0 ? "" : " hidden"}>
          ${t.image
            ? zoomable({ src: t.image, alt: `${tierName(t.tier)} redesign of the ${room.toLowerCase()}`, group: p.id, label: `${room} · ${tierName(t.tier)}`, status: t.status })
            : `<div class="no-image">${STATUS[t.status].label}. ${STATUS[t.status].meaning}.</div>`}
          <p class="figcap">${tierName(t.tier)} · ${TIER_LABELS[t.tier].blurb}</p>
        </div>`).join("")}
      </div>
    </div>
    <div class="info">
      <div class="info-tier">
        ${p.tiers.map((t, i) => `<div role="tabpanel" id="${p.id}-info-${t.tier}" aria-labelledby="${p.id}-tab-${t.tier}" data-panel="${p.id}:${t.tier}"${i === 0 ? "" : " hidden"}>${tierInfo(t)}</div>`).join("")}
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

  // Ending: where the money goes, and which images not to lean on.
  const decide = `
  <section class="decide" aria-labelledby="decide-h">
    <h2 id="decide-h">Before you decide</h2>
    <div class="decide-grid" style="--cols:${tiers.length}">
      ${tiers.map((tier) => {
        const x = totals.get(tier);
        const drivers = photos
          .flatMap((p) => (p.tiers.find((t) => t.tier === tier)?.plan.changes ?? []).map((c) => ({ room: roomName(p), c })))
          .filter(({ c }) => Number.isFinite(c.costHigh))
          .sort((a, b) => b.c.costHigh - a.c.costHigh)
          .filter((d, i, all) => all.findIndex((e) => baseRoom(e.room) === baseRoom(d.room) && e.c.element === d.c.element) === i)
          .slice(0, 4);
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#fafaf9; --surface:#ffffff; --surface-2:#f1f0ee; --text:#1b1a19; --muted:#66625d;
    --line:rgba(27,26,25,.09); --line-strong:rgba(27,26,25,.2);
    --accent:#4c6249; --ok:#3d6a4c; --warn:#8a6216; --bad:#9a3b2f;
    --font:"Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color-scheme:light dark;
  }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#121211; --surface:#1a1a19; --surface-2:#242322; --text:#ecebe8; --muted:#a39f99;
    --line:rgba(236,235,232,.09); --line-strong:rgba(236,235,232,.22);
    --accent:#9db59a; --ok:#8fc49f; --warn:#e0bd78; --bad:#ee9d90;
  } }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  html { -webkit-tap-highlight-color:transparent; scrollbar-color:var(--line-strong) transparent; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 var(--font); caret-color:var(--text); }
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
  .page-head { margin:8px 0 40px; }
  .meta { margin:8px 0 0; color:var(--muted); font-size:14px; }
  .meta span + span::before { content:"·"; margin:0 8px; opacity:.6; }
  .notice { margin:16px 0 0; font-size:14px; color:var(--warn); }

  .status { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:500; white-space:nowrap; }
  .status .icon { width:14px; height:14px; }
  .status-meaning { color:var(--muted); font-weight:400; white-space:normal; }
  .s-verified { color:var(--ok); } .s-review { color:var(--warn); } .s-failed, .s-error { color:var(--bad); } .s-unchanged { color:var(--muted); }
  .status > span:not(.status-meaning) { color:var(--text); }

  /* Overview: image-led plates with gallery-label captions */
  .lede { margin:6px 0 20px; color:var(--muted); max-width:65ch; }
  .plates { display:grid; gap:20px; grid-template-columns:repeat(var(--cols), minmax(0, 1fr)); }
  .plate { margin:0; min-width:0; }
  .plate figcaption { display:flex; flex-direction:column; gap:2px; padding-top:12px; }
  .plate-title { font-weight:600; }
  .plate-sub { color:var(--muted); font-size:13px; }
  .plate-total { font-size:22px; font-weight:500; letter-spacing:-.01em; margin-top:10px; }
  .plate-tally { font-size:13px; margin-top:8px; color:var(--muted); }
  .legend { display:flex; flex-wrap:wrap; gap:8px 28px; margin:28px 0 0; padding:14px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
  .legend div { display:flex; gap:8px; align-items:baseline; } .legend dt, .legend dd { margin:0; } .legend dd { color:var(--muted); font-size:13px; }
  .method { max-width:72ch; }
  .method p { color:var(--muted); font-size:14px; margin:0 0 10px; }

  /* Images */
  .zoom { position:relative; display:block; width:100%; padding:0; border:0; background:var(--surface-2); border-radius:3px; overflow:hidden; cursor:zoom-in; aspect-ratio:3 / 2; }
  .zoom img { width:100%; height:100%; object-fit:cover; display:block; transition:transform .5s cubic-bezier(.16,1,.3,1); }
  .zoom:hover img { transform:scale(1.015); }
  .zoom-hint { position:absolute; right:10px; bottom:10px; width:32px; height:32px; display:grid; place-items:center; border-radius:50%; background:rgba(18,18,17,.55); color:#fff; opacity:0; transition:opacity .2s; }
  .zoom:hover .zoom-hint, .zoom:focus-visible .zoom-hint { opacity:1; }
  .no-image { aspect-ratio:3 / 2; display:grid; place-items:center; border-radius:3px; border:1px dashed var(--line-strong); color:var(--muted); font-size:13px; text-align:center; padding:16px; }

  /* By room */
  .by-room { margin-top:64px; }
  .table-scroll { margin-top:14px; overflow-x:auto; background:
      linear-gradient(to right, var(--bg) 30%, transparent) left / 32px 100% no-repeat local,
      linear-gradient(to left, var(--bg) 30%, transparent) right / 32px 100% no-repeat local,
      radial-gradient(farthest-side at 0 50%, var(--line-strong), transparent) left / 10px 100% no-repeat scroll,
      radial-gradient(farthest-side at 100% 50%, var(--line-strong), transparent) right / 10px 100% no-repeat scroll; }
  table { width:100%; min-width:560px; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; vertical-align:top; padding:12px 16px 12px 0; border-bottom:1px solid var(--line); }
  thead th { font-weight:500; color:var(--muted); font-size:13px; padding-bottom:8px; }
  tbody th { font-weight:500; } tbody th a { text-decoration:none; } tbody th a:hover { text-decoration:underline; }
  .cell-cost { margin-top:4px; color:var(--muted); font-size:13px; }
  tfoot th, tfoot td { border-bottom:0; padding-top:14px; font-weight:600; font-size:15px; }

  /* Sticky controls */
  .toolbar { position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:10px 16px; align-items:center; margin:56px -20px 0; padding:10px 20px; background:var(--bg); border-bottom:1px solid var(--line); }
  .toolbar .crumb { margin-right:auto; }
  select { font:inherit; font-size:14px; min-height:36px; padding:6px 30px 6px 10px; border-radius:8px; border:1px solid var(--line-strong); color:inherit; background:var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%2366625d' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E") no-repeat right 8px center; appearance:none; }
  .seg { display:inline-flex; padding:2px; border-radius:9px; background:var(--surface-2); }
  .seg button { font:inherit; font-size:13px; font-weight:500; min-height:32px; padding:4px 12px; border:0; border-radius:7px; background:transparent; color:var(--muted); cursor:pointer; touch-action:manipulation; }
  .seg button:hover { color:var(--text); }
  .seg button[aria-pressed="true"] { background:var(--surface); color:var(--text); box-shadow:0 1px 2px rgba(0,0,0,.08); }
  .seg-label { font-size:13px; color:var(--muted); }

  /* Rooms */
  .room { padding-top:48px; margin-top:48px; border-top:1px solid var(--line); scroll-margin-top:64px; }
  .room-head { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:end; gap:12px 24px; margin-bottom:16px; }
  .room-title { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .file { font-size:13px; color:var(--muted); }
  .tabs { display:inline-flex; padding:2px; border-radius:9px; background:var(--surface-2); }
  .tabs [role="tab"] { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:13px; font-weight:500; min-height:34px; padding:4px 12px; border:0; border-radius:7px; background:transparent; color:var(--muted); cursor:pointer; touch-action:manipulation; }
  .tabs [role="tab"]:hover { color:var(--text); }
  .tabs [role="tab"][aria-selected="true"] { background:var(--surface); color:var(--text); box-shadow:0 1px 2px rgba(0,0,0,.08); }
  .tab-mark { display:inline-flex; } .tab-mark .icon { width:13px; height:13px; }
  .pair { display:grid; gap:12px; grid-template-columns:repeat(2, minmax(0, 1fr)); }
  .frame { margin:0; min-width:0; }
  .frame figcaption, .figcap { margin:8px 0 0; font-size:13px; color:var(--muted); }
  .info { display:grid; gap:12px 32px; grid-template-columns:repeat(2, minmax(0, 1fr)); margin-top:20px; align-items:start; }
  .info-tier { grid-column:2; grid-row:1; }
  .info-listing { grid-column:1; grid-row:1; }
  .verdict { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:baseline; gap:8px 16px; padding-bottom:12px; border-bottom:1px solid var(--line); }
  .verdict-cost { font-size:18px; font-weight:500; }

  details.fold { border-bottom:1px solid var(--line); }
  details.fold > summary { display:flex; align-items:center; gap:8px; min-height:44px; cursor:pointer; list-style:none; font-weight:500; font-size:14px; }
  details.fold > summary::-webkit-details-marker { display:none; }
  details.fold > summary::after { content:""; margin-left:auto; width:7px; height:7px; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:translateY(-2px) rotate(45deg); transition:transform .2s; }
  details.fold[open] > summary::after { transform:translateY(2px) rotate(-135deg); }
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
  .decide { margin-top:96px; padding-top:40px; border-top:1px solid var(--line-strong); }
  .decide-grid { display:grid; gap:32px; margin-top:24px; grid-template-columns:repeat(var(--cols), minmax(0, 1fr)); }
  .decide-col h3 { display:flex; justify-content:space-between; gap:12px; align-items:baseline; font-size:16px; padding-bottom:10px; border-bottom:1px solid var(--line); }
  .decide-col h3 .num { font-weight:500; }
  .drivers { list-style:none; margin:8px 0 0; padding:0; font-size:14px; }
  .drivers li { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--line); }
  .shaky { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; font-size:14px; margin:14px 0 0; }
  .end-links { display:flex; gap:24px; margin-top:48px; font-size:14px; }
  .end-links a { display:inline-flex; gap:6px; align-items:center; color:var(--muted); text-decoration:none; } .end-links a:hover { color:var(--text); }

  @media (max-width: 900px) {
    .plates { grid-template-columns:repeat(2, minmax(0, 1fr)); }
    .decide-grid { grid-template-columns:minmax(0, 1fr); }
  }
  @media (max-width: 680px) {
    main { padding-top:16px; }
    .pair, .info { grid-template-columns:minmax(0, 1fr); }
    .info-tier, .info-listing { grid-column:1; grid-row:auto; }
    .toolbar .crumb span { display:none; }
    .seg-label, .toolbar .seg { display:none; } /* each room keeps its own scope tabs on small screens */
    .toolbar select { flex:1; }
    .room-head { align-items:start; }
    .tabs { width:100%; } .tabs [role="tab"] { flex:1; justify-content:center; }
  }

  .to-top { position:fixed; right:max(16px, env(safe-area-inset-right)); bottom:max(16px, env(safe-area-inset-bottom)); z-index:6; width:44px; height:44px; display:grid; place-items:center; border-radius:50%; border:1px solid var(--line-strong); background:var(--surface); color:inherit; cursor:pointer; opacity:0; transform:translateY(8px); transition:opacity .25s, transform .25s cubic-bezier(.16,1,.3,1); pointer-events:none; }
  .to-top.show { opacity:1; transform:none; pointer-events:auto; }

  dialog.viewer { width:100vw; height:100dvh; max-width:none; max-height:none; margin:0; padding:0; border:0; background:#0f0f0e; color:#efede9; }
  dialog.viewer::backdrop { background:rgba(0,0,0,.85); }
  .viewer-bar { display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; justify-content:space-between; padding:10px max(14px, env(safe-area-inset-left)); border-bottom:1px solid rgba(255,255,255,.1); min-height:62px; }
  .viewer-title { display:flex; flex-direction:column; gap:2px; min-width:0; }
  .viewer-title strong { font-weight:500; }
  .viewer-title .status > span:not(.status-meaning) { color:#efede9; }
  .viewer-title .status-meaning { color:rgba(239,237,233,.6); }
  .viewer-title .s-verified { color:#8fc49f; } .viewer-title .s-review { color:#e0bd78; } .viewer-title .s-failed, .viewer-title .s-error { color:#ee9d90; }
  .viewer .seg { background:rgba(255,255,255,.08); } .viewer .seg button { color:rgba(239,237,233,.7); } .viewer .seg button[aria-pressed="true"] { background:#efede9; color:#0f0f0e; }
  .viewer-actions { display:flex; gap:6px; align-items:center; }
  .viewer-hint { font-size:12px; color:rgba(239,237,233,.55); margin-right:6px; }
  .vbtn { font:inherit; font-size:13px; min-height:36px; padding:4px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.22); background:transparent; color:inherit; cursor:pointer; }
  .vbtn[aria-pressed="true"] { background:#efede9; color:#0f0f0e; }
  .viewer-stage { height:calc(100dvh - 62px); overflow:auto; overscroll-behavior:contain; display:grid; place-items:center; cursor:zoom-in; }
  .viewer-stage img { max-width:100vw; max-height:calc(100dvh - 62px); object-fit:contain; display:block; user-select:none; -webkit-user-drag:none; }
  .viewer-stage.actual { place-items:start; cursor:grab; } .viewer-stage.actual.dragging { cursor:grabbing; }
  .viewer-stage.actual img { max-width:none; max-height:none; }
  @media (max-width: 680px) { .viewer-hint { display:none; } }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; scroll-behavior:auto !important; } }
</style>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<main id="content">
  <header class="page-head">
    ${back ? `<a class="crumb" href="${back.href}" data-back>${icon("arrowLeft")}${back.label}</a>` : ""}
    <h1 id="top" tabindex="-1">${esc(input.title)}</h1>
    <p class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</p>
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

<dialog class="viewer" aria-labelledby="viewer-title">
  <div class="viewer-bar">
    <div class="viewer-title"><strong id="viewer-title"></strong><span id="viewer-status"></span></div>
    <div class="seg viewer-tabs" role="group" aria-label="Compare versions"></div>
    <div class="viewer-actions">
      <span class="viewer-hint">← → compare · Z zoom</span>
      <button class="vbtn" type="button" data-viewer="zoom" aria-pressed="false">100%</button>
      <button class="vbtn" type="button" data-viewer="close">Close</button>
    </div>
  </div>
  <div class="viewer-stage"></div>
</dialog>

<script>
(() => {
  const STATUS = ${JSON.stringify(Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, { label: v.label, meaning: v.meaning, icon: icon(v.icon) }])))};

  /* Scope tabs: WAI-ARIA tabs with automatic activation */
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
  }
  function setAll(tier) {
    document.querySelectorAll(".tabs").forEach((list) => {
      const first = list.querySelector('[role="tab"]');
      if (first) selectTier(first.dataset.room, tier, false);
    });
    document.querySelectorAll("[data-all-tier]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.allTier === tier)));
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

  document.getElementById("room-jump")?.addEventListener("change", (e) => {
    const id = e.target.value;
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const h = document.getElementById(id + "-h");
    h?.setAttribute("tabindex", "-1");
    h?.focus({ preventScroll: true });
    e.target.value = "";
  });

  /* Viewer */
  const dialog = document.querySelector("dialog.viewer");
  const stage = dialog.querySelector(".viewer-stage");
  // Created on first open so the closed dialog carries no source-less <img>.
  const img = document.createElement("img");
  img.alt = "";
  const tabsEl = dialog.querySelector(".viewer-tabs");
  const title = dialog.querySelector("#viewer-title");
  const statusEl = dialog.querySelector("#viewer-status");
  const zoomBtn = dialog.querySelector('[data-viewer="zoom"]');
  let items = [], index = 0, trigger = null;

  function show(i, keepZoom) {
    index = (i + items.length) % items.length;
    const item = items[index];
    if (!img.isConnected) stage.append(img);
    img.src = item.dataset.src;
    img.alt = item.dataset.label;
    title.textContent = item.dataset.label;
    const s = STATUS[item.dataset.status];
    statusEl.innerHTML = s ? '<span class="status s-' + item.dataset.status + '">' + s.icon + "<span>" + s.label + '</span><span class="status-meaning">' + s.meaning + "</span></span>" : "";
    tabsEl.querySelectorAll("button").forEach((b, n) => b.setAttribute("aria-pressed", String(n === index)));
    if (!keepZoom) setZoom(false);
  }
  function setZoom(actual, point) {
    const before = stage.getBoundingClientRect();
    const ratio = point ? { x: (point.x - before.left) / before.width, y: (point.y - before.top) / before.height } : null;
    stage.classList.toggle("actual", actual);
    zoomBtn.setAttribute("aria-pressed", String(actual));
    zoomBtn.textContent = actual ? "Fit" : "100%";
    if (actual && ratio) {
      stage.scrollLeft = img.naturalWidth * ratio.x - stage.clientWidth / 2;
      stage.scrollTop = img.naturalHeight * ratio.y - stage.clientHeight / 2;
    }
  }
  document.addEventListener("click", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) return selectTier(tab.dataset.room, tab.dataset.tier, false);
    const all = e.target.closest("[data-all-tier]");
    if (all) return setAll(all.dataset.allTier);
    const z = e.target.closest(".zoom");
    if (z) {
      trigger = z;
      items = [...document.querySelectorAll('.zoom[data-group="' + CSS.escape(z.dataset.group) + '"]')];
      tabsEl.innerHTML = items.map((it, n) => '<button type="button" data-index="' + n + '" aria-pressed="false">' + it.dataset.label.split(" · ").pop().replace("Listing photo", "Listing") + "</button>").join("");
      dialog.showModal();
      show(items.indexOf(z));
      tabsEl.querySelector('[aria-pressed="true"]')?.focus();
      return;
    }
    const vt = e.target.closest(".viewer-tabs button");
    if (vt) return show(Number(vt.dataset.index), true);
    if (e.target.closest('[data-viewer="close"]')) return dialog.close();
    if (e.target.closest('[data-viewer="zoom"]')) return setZoom(!stage.classList.contains("actual"));
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
    if (!wasDrag && e.target === img) setZoom(!stage.classList.contains("actual"), { x: e.clientX, y: e.clientY });
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); show(index + 1, true); }
    if (e.key === "ArrowLeft") { e.preventDefault(); show(index - 1, true); }
    if (e.key === "z" || e.key === "Z") setZoom(!stage.classList.contains("actual"));
  });
  dialog.addEventListener("close", () => { img.remove(); trigger?.focus(); });

  /* Return to the exact picker state when that's where we came from. */
  try {
    const ref = document.referrer && new URL(document.referrer);
    if (ref && ref.origin === location.origin && ref.pathname === "/") {
      document.querySelectorAll("a[data-back]").forEach((a) => {
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

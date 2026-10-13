/** The phone tab bar for server-rendered pages (the app shell draws its own copy in index.html). */
const TABS = [
  { href: "/", key: "home", label: "Home", path: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>' },
  { href: "/?view=listings", key: "listings", label: "Listings", path: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>' },
  { href: "/?view=tastes", key: "tastes", label: "Tastes", path: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z"/><path d="M20 2v4M18 4h4"/>' },
  { href: "/?view=reports", key: "reports", label: "Redesigns", path: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16"/><path d="m3.5 17 4-4.5 3 3"/><path d="m13.5 16 3-3.5 4 4.5"/><circle cx="7.5" cy="8.5" r="1"/>' },
] as const;

export type MobileTab = (typeof TABS)[number]["key"];

export const mobileTabsCss = `
  .mobile-tabs { display:none; }
  @media (max-width:860px), (hover:none) and (pointer:coarse) and (orientation:landscape) and (max-height:600px) {
    body { padding-bottom:calc(112px + env(safe-area-inset-bottom)); }
    .mobile-tabs { position:fixed; z-index:25; bottom:max(8px, env(safe-area-inset-bottom)); left:max(16px, env(safe-area-inset-left)); display:grid; width:calc(100% - 88px); max-width:440px; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:4px; padding:6px; border:0; border-radius:999px; background:color-mix(in srgb, var(--surface) 82%, transparent); box-shadow:0 8px 32px rgba(0,0,0,.12), 0 0 0 1px color-mix(in srgb, var(--line) 70%, transparent); transform-origin:0 100%; transform:scale(var(--nav-scale, 1)); will-change:transform; }
    .mobile-tabs a { display:flex; flex-direction:column; justify-content:center; align-items:center; min-height:52px; border-radius:999px; color:var(--muted); text-decoration:none; font-size:11px; font-weight:500; line-height:1.2; --motion:background-color var(--fast) var(--ease), color var(--fast) var(--ease), transform var(--fast) var(--ease); }
    .mobile-tabs .icon { width:24px; height:24px; }
    .mobile-tabs a[aria-current="page"] { background:var(--primary-fill); color:var(--primary-text); font-weight:600; box-shadow:var(--primary-shadow); }
    .mobile-tabs a:active { transform:scale(.96); }
  }
  @supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))) {
    @media (max-width:860px), (hover:none) and (pointer:coarse) and (orientation:landscape) and (max-height:600px) { .mobile-tabs { backdrop-filter:blur(28px) saturate(1.6); -webkit-backdrop-filter:blur(28px) saturate(1.6); } }
  }`;

export function mobileTabsHtml(active: MobileTab): string {
  return `<nav class="mobile-tabs" aria-label="Main navigation">${TABS.map((t) => `<a href="${t.href}" aria-label="${t.label}"${t.key === active ? ' aria-current="page"' : ""}><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${t.path}</svg></a>`).join("")}</nav>`;
}

/** Same linear shrink-while-scrolling as the app shell. */
export const mobileTabsScript = `(() => {
  const bar = document.querySelector(".mobile-tabs"), top = document.querySelector(".to-top");
  if (!bar) return;
  const SMALLEST = .82, RANGE = 120, rate = (1 - SMALLEST) / RANGE;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let last = scrollY, scale = 1, written = 1, ticking = false;
  const update = () => {
    ticking = false;
    const y = Math.max(0, Math.min(scrollY, document.documentElement.scrollHeight - innerHeight));
    scale = reduce.matches ? 1 : Math.min(1, Math.max(scale - (y - last) * rate, SMALLEST, 1 - y * rate));
    last = y;
    const next = Math.round(scale * 1000) / 1000;
    if (next !== written) { written = next; bar.style.setProperty("--nav-scale", String(next)); if (top) top.style.setProperty("--nav-scale", String(next)); }
  };
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
})();`;

import { readFileSync } from "node:fs";

const asset = (name: string) => readFileSync(new URL(`./app/brand/${name}.svg`, import.meta.url), "utf8").trim();
const dataUrl = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

export const WHIM_LOCKUPS = { light: asset("whim-lockup-light"), dark: asset("whim-lockup-dark") };
const favicons = { light: dataUrl(asset("whim-mark-light")), dark: dataUrl(asset("whim-mark-dark")) };

// Outlined artwork also draws directly in PDFs, without rasterizing the logo.
export const WHIM_PATHS = {
  mark: /id="whim-mark"[^>]* d="([^"]+)"/.exec(WHIM_LOCKUPS.light)![1]!,
  wordmark: /id="whim-wordmark"[^>]* d="([^"]+)"/.exec(WHIM_LOCKUPS.light)![1]!,
};

export const brandLockup = `<span class="whim-lockup" aria-hidden="true">
  <img class="whim-logo whim-logo-light" src="${dataUrl(WHIM_LOCKUPS.light)}" alt="" width="1405" height="340">
  <img class="whim-logo whim-logo-dark" src="${dataUrl(WHIM_LOCKUPS.dark)}" alt="" width="1405" height="340">
</span>`;

export const brandHead = `<meta name="application-name" content="Whim">
<meta name="apple-mobile-web-app-title" content="Whim">
<link id="whim-favicon" rel="icon" type="image/svg+xml" sizes="any" href="${favicons.light}" data-light="${favicons.light}" data-dark="${favicons.dark}">
<style>
  .whim-lockup { display:block; width:132px; height:32px; }
  .whim-logo { display:block; width:100%; height:100%; object-fit:contain; }
  .whim-logo-dark { display:none; }
  :root[data-theme="dark"] .whim-logo-light { display:none; }
  :root[data-theme="dark"] .whim-logo-dark { display:block; }
  .report-brand { display:block; width:fit-content; margin:0 0 20px; text-decoration:none; }
  @media print {
    .whim-logo-light { display:block !important; }
    .whim-logo-dark { display:none !important; }
  }
</style>`;

// Follow the system setting by default, with a per-tab override from the display toggle.
// Share this bootstrap between the app and standalone reports to keep artwork and favicons in sync.
export const appearanceScript = `<script>
(() => {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const read = () => { try { return sessionStorage.getItem('remodel-lens-display'); } catch { return null; } };
  const apply = () => {
    const base = system.matches ? 'dark' : 'light';
    const saved = read();
    const theme = saved === 'light' || saved === 'dark' ? saved : base;
    document.documentElement.dataset.theme = theme;
    const favicon = document.getElementById('whim-favicon');
    if (favicon && favicon.getAttribute('href') !== favicon.dataset[theme]) favicon.setAttribute('href', favicon.dataset[theme]);
    const next = theme === 'dark' ? 'light' : 'dark';
    document.querySelectorAll('[data-display-toggle]').forEach(button => {
      button.dataset.current = theme;
      button.setAttribute('aria-label', 'Switch to ' + next + ' mode');
      button.dataset.tip = next === 'dark' ? 'Dark mode' : 'Light mode';
    });
  };
  try { localStorage.removeItem('remodel-lens-display'); document.cookie = 'remodel-lens-display=; Path=/; Max-Age=0'; } catch {}
  apply();
  system.addEventListener('change', apply);
  addEventListener('display-change', apply);
  document.addEventListener('DOMContentLoaded', apply);
})();
</script>`;

export function brandAppHtml(template: string): string {
  return template
    .replace("<!-- WHIM_HEAD -->", brandHead)
    .replace("<!-- WHIM_APPEARANCE -->", appearanceScript)
    .replace("<!-- WHIM_LOCKUP -->", brandLockup);
}

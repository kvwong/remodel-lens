/**
 * Shared by the app shell and every report page (brandHead): page transitions between
 * documents, a photo that carries over from the tapped thumbnail into the report, and
 * photos that sharpen in instead of popping. App-only extras live in src/app/smooth.js.
 */
export const smoothCss = `
  @view-transition { navigation:auto; }
  ::view-transition-group(*) { animation-duration:.26s; animation-timing-function:cubic-bezier(.2,.8,.2,1); }
  ::view-transition-old(root) { animation:.16s ease-in both whim-page-out; }
  ::view-transition-new(root) { animation:.26s cubic-bezier(.2,.8,.2,1) both whim-page-in; }
  @keyframes whim-page-out { to { opacity:0; } }
  @keyframes whim-page-in { from { opacity:0; transform:translateY(10px); } }
  /* The tab bar and sidebar stay put (only the lit tab cross-fades) while the page under them changes. */
  .mobile-tabs { view-transition-name:whim-tabs; }
  .side { view-transition-name:whim-side; }
  ::view-transition-group(whim-photo) { animation-duration:.36s; z-index:2; }
  ::view-transition-old(whim-photo), ::view-transition-new(whim-photo) { height:100%; object-fit:cover; }
  /* Photos show a quiet placeholder tone while loading, then sharpen in. */
  img:not([data-shown]):not([src^="data:"]) { background-color:color-mix(in srgb, var(--line) 55%, transparent); }
  img[data-shown="fade"] { animation:whim-photo-in .38s cubic-bezier(.2,.8,.2,1); }
  @keyframes whim-photo-in { from { filter:blur(10px); opacity:.4; } }
  @media (prefers-reduced-motion: reduce) {
    @view-transition { navigation:none; }
    img[data-shown="fade"] { animation:none; }
  }`;

export const smoothScript = `(() => {
  // Photos: mark each as shown once loaded. One that arrives after a beat sharpens in; one already
  // cached (tab switches, the skeleton's blanks) appears as is, so nothing flickers.
  const added = new WeakMap();
  const seen = (img) => { if (img.complete && img.naturalWidth) img.setAttribute("data-shown", ""); else added.set(img, performance.now()); };
  document.addEventListener("load", (e) => { if (e.target.localName === "img") { const t = added.get(e.target); added.delete(e.target); if (!e.target.hasAttribute("data-shown")) e.target.setAttribute("data-shown", t !== undefined && performance.now() - t > 70 ? "fade" : ""); } }, true);
  document.addEventListener("error", (e) => { if (e.target.localName === "img") e.target.setAttribute("data-shown", ""); }, true);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.localName === "img") seen(n);
      else if (n.firstElementChild) for (const img of n.getElementsByTagName("img")) seen(img);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Shared photo: the thumbnail tapped on one page grows into the same photo on the next.
  const KEY = "whim-vt-photo";
  const photoPath = (src) => { try { return new URL(src, location.href).pathname.replace(/^\\/(thumb|files)\\//, "/"); } catch { return ""; } };
  let tapped = null;
  document.addEventListener("click", (e) => {
    const link = e.target.closest?.("a[href]");
    const img = link && (e.target.closest("img") || link.querySelector("img"));
    tapped = img && img.currentSrc ? { img, href: link.href, at: Date.now() } : null;
  }, true);
  addEventListener("pageswap", (e) => {
    if (!e.viewTransition || !tapped || Date.now() - tapped.at > 3000 || !tapped.img.isConnected) return;
    const to = e.activation?.entry?.url;
    if (to && to.split("#")[0] !== tapped.href.split("#")[0]) return;
    const r = tapped.img.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    tapped.img.style.viewTransitionName = "whim-photo";
    try { sessionStorage.setItem(KEY, JSON.stringify({ path: photoPath(tapped.img.currentSrc), src: tapped.img.currentSrc })); } catch {}
  });
  addEventListener("pageshow", () => { if (tapped?.img) tapped.img.style.viewTransitionName = ""; tapped = null; });
  addEventListener("pagereveal", (e) => {
    let from = null;
    try { from = JSON.parse(sessionStorage.getItem(KEY) || "null"); sessionStorage.removeItem(KEY); } catch {}
    if (!e.viewTransition || !from?.path) return;
    const match = [...document.images].find((img) => {
      if (photoPath(img.getAttribute("src") || "") !== from.path) return false;
      const r = img.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    });
    if (!match) return;
    match.style.viewTransitionName = "whim-photo";
    // Until the larger copy arrives, the thumbnail already in the cache stands in for it.
    if (!match.complete) { match.style.background = "url(" + JSON.stringify(from.src) + ") center / cover"; match.addEventListener("load", () => match.style.removeProperty("background"), { once: true }); }
    e.viewTransition.finished.finally(() => { match.style.viewTransitionName = ""; });
  });
})();`;

export const smoothHead = `<style>${smoothCss}</style>\n<script>${smoothScript}</script>`;

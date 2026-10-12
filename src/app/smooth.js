// App-served pages only (the app shell and report pages it links to; never downloaded reports).
// Registers the service worker and, as a finger lands on a link to a report, asks it to start
// loading that report so it is ready (or nearly) by the time the tap completes.
(() => {
  if (!("serviceWorker" in navigator) || !isSecureContext) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  const asked = new Map();
  const warm = (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !/\/report\.html$/.test(url.pathname)) return;
    url.hash = "";
    const key = url.href, now = Date.now();
    if (now - (asked.get(key) ?? 0) < 8000) return;
    asked.set(key, now);
    navigator.serviceWorker.controller?.postMessage({ type: "prefetch", url: key });
  };
  addEventListener("pointerdown", warm, { capture: true, passive: true });
  // Keyboard and mouse users focus or hover a link a beat before opening it.
  addEventListener("focusin", warm, true);
})();

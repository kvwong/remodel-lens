/* Pull to refresh for the home screen app on iPhone, which has no browser chrome to pull or reload from. */
(() => {
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  if (!standalone || !matchMedia("(pointer: coarse)").matches) return;

  const THRESHOLD = 72; // px of (damped) pull that arms the refresh
  const MAX = 128;
  const REST = 72; // how far the page stays down while the spinner shows
  const MIN_SPIN = 600; // ms, so a fast refresh still reads as one
  const FLAG = "whim-pull-refresh";
  // Fields and the photo viewer stage keep their own touches. The photo viewer (split view,
  // pins, zoom) and every other dialog also block pulls while open. The hero reel stays
  // pullable: it only takes sideways drags, and a pull that turns sideways lets go below.
  const OWN_GESTURES = ".viewer-stage, input, textarea, select, [contenteditable], [data-no-pull]";
  // The page moves down with the pull so the indicator sits in the gap above it, not over the
  // logo, and low enough to clear iOS's blur under the status bar.
  const SHIFTED = "body > .banner, body > .layout, body > main";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");

  let start = null, decided = false, pull = 0, refreshing = false, el = null;

  function indicator() {
    if (el) return el;
    const style = document.createElement("style");
    style.textContent = `
      .ptr { position:fixed; z-index:40; top:calc(env(safe-area-inset-top) + 28px); left:50%; width:40px; height:40px; margin-left:-20px; display:grid; place-items:center; border-radius:50%; background:var(--surface, #fff); color:var(--text, #1b1a19); box-shadow:0 2px 12px rgba(0,0,0,.16); pointer-events:none; opacity:0; transform:translateY(-56px); }
      .ptr svg { width:20px; height:20px; transition:transform .18s ease; }
      .ptr[data-armed] svg { transform:rotate(180deg); }
      .ptr[data-busy] svg { display:none; }
      .ptr[data-busy]::after { content:""; width:18px; height:18px; border-radius:50%; border:2px solid currentColor; border-right-color:transparent; animation:ptr-spin .7s linear infinite; }
      .ptr.settle, .ptr-settle { transition:transform .25s cubic-bezier(.22,1,.36,1), opacity .25s ease; }
      @keyframes ptr-spin { to { transform:rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .ptr svg, .ptr.settle, .ptr-settle { transition:none; } .ptr[data-busy]::after { animation-duration:2.4s; } }`;
    document.head.append(style);
    el = document.createElement("div");
    el.className = "ptr";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
    document.body.append(el);
    return el;
  }

  function show(distance, settle = false) {
    const node = indicator();
    const animate = settle && !reduce.matches;
    node.classList.toggle("settle", animate);
    node.style.transform = `translateY(${Math.round(Math.min(0, distance - REST))}px)`;
    node.style.opacity = String(Math.min(1, distance / THRESHOLD));
    node.toggleAttribute("data-armed", distance >= THRESHOLD);
    for (const part of document.querySelectorAll(SHIFTED)) {
      part.classList.toggle("ptr-settle", animate);
      part.style.transform = distance > 0 ? `translateY(${Math.round(distance)}px)` : "";
    }
  }

  function busy(on) {
    indicator().toggleAttribute("data-busy", on);
    indicator().setAttribute("aria-hidden", on ? "false" : "true");
    if (on) indicator().setAttribute("aria-label", "Refreshing");
    refreshing = on;
  }

  // A pull inside something that scrolls on its own (a log, a menu) belongs to that element.
  function insideScroller(node) {
    for (let n = node; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return true;
    }
    return false;
  }

  function reset() {
    start = null;
    decided = false;
    if (pull > 0) show(0, true);
    pull = 0;
  }

  async function refresh() {
    busy(true);
    show(REST, true);
    const began = performance.now();
    // Pages that can refresh in place call waitUntil (the spinner holds until it settles), or
    // cancel the event to skip the refresh (e.g. unsaved edits). Otherwise the page reloads.
    let work = null;
    const event = new CustomEvent("whim:refresh", { cancelable: true, detail: { waitUntil: (promise) => { work = promise; } } });
    const proceed = dispatchEvent(event);
    if (!work && !proceed) { busy(false); show(0, true); return; }
    if (!work) {
      try { sessionStorage.setItem(FLAG, "1"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150)); // let the spinner paint first
      location.reload();
      return;
    }
    try { await work; } catch {}
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, MIN_SPIN - (performance.now() - began))));
    busy(false);
    show(0, true);
  }

  addEventListener("touchstart", (e) => {
    start = null;
    if (refreshing || e.touches.length !== 1 || scrollY > 0 || document.querySelector("dialog[open]")) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest(OWN_GESTURES) || insideScroller(target)) return;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    decided = false;
    pull = 0;
  }, { passive: true });

  addEventListener("touchmove", (e) => {
    if (!start) return;
    if (e.touches.length !== 1) return reset();
    const dx = e.touches[0].clientX - start.x, dy = e.touches[0].clientY - start.y;
    // Decide on the first move: iOS ignores preventDefault once it has started scrolling.
    if (!decided) {
      decided = true;
      if (!(dy > 0 && dy >= Math.abs(dx)) || scrollY > 0) { start = null; return; }
    }
    if (Math.abs(dx) > Math.max(dy, 8)) return reset(); // turned sideways, e.g. into a reel drag
    if (e.cancelable) e.preventDefault();
    pull = dy <= 0 ? 0 : MAX * (1 - Math.exp(-dy / MAX)); // rubber-band resistance
    show(pull);
  }, { passive: false });

  addEventListener("touchend", () => {
    if (!start) return;
    start = null;
    if (pull < THRESHOLD) return reset();
    pull = 0;
    refresh();
  });
  addEventListener("touchcancel", () => { if (start) reset(); });

  // After a full reload, keep the spinner up until the new page has loaded, then let it go.
  let reloaded = false;
  try { reloaded = sessionStorage.getItem(FLAG) === "1"; sessionStorage.removeItem(FLAG); } catch {}
  if (reloaded) {
    busy(true);
    show(REST);
    const done = () => setTimeout(() => { busy(false); show(0, true); }, 250);
    if (document.readyState === "complete") done(); else addEventListener("load", done, { once: true });
  }
  // Coming back from the bfcache should not leave a spinner behind.
  addEventListener("pageshow", (e) => { if (e.persisted && refreshing) { busy(false); show(0); } });
})();

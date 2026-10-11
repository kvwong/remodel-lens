/* Pull to refresh for the home screen app on iPhone, which has no browser chrome to pull or reload from. */
(() => {
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  if (!standalone || !matchMedia("(pointer: coarse)").matches) return;

  const THRESHOLD = 72; // px of (damped) pull that arms the refresh
  const MAX = 128;
  // Fields and the photo viewer stage keep their own touches. The photo viewer (split view,
  // pins, zoom) and every other dialog also block pulls while open. The hero reel stays
  // pullable: it only takes sideways drags, and a pull that turns sideways lets go below.
  const OWN_GESTURES = ".viewer-stage, input, textarea, select, [contenteditable], [data-no-pull]";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");

  let start = null, decided = false, pull = 0, refreshing = false, el = null;

  function indicator() {
    if (el) return el;
    const style = document.createElement("style");
    style.textContent = `
      .ptr { position:fixed; z-index:40; top:calc(env(safe-area-inset-top) + 8px); left:50%; width:40px; height:40px; margin-left:-20px; display:grid; place-items:center; border-radius:50%; background:var(--surface, #fff); color:var(--text, #1b1a19); border:1px solid var(--line-strong, rgba(0,0,0,.14)); box-shadow:0 4px 16px rgba(0,0,0,.14); pointer-events:none; opacity:0; transform:translateY(-56px); }
      .ptr svg { width:20px; height:20px; transition:transform .18s ease; }
      .ptr[data-armed] svg { transform:rotate(180deg); }
      .ptr[data-busy] svg { display:none; }
      .ptr[data-busy]::after { content:""; width:18px; height:18px; border-radius:50%; border:2px solid currentColor; border-right-color:transparent; animation:ptr-spin .7s linear infinite; }
      .ptr.settle { transition:transform .22s ease, opacity .22s ease; }
      @keyframes ptr-spin { to { transform:rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .ptr svg, .ptr.settle { transition:none; } .ptr[data-busy]::after { animation-duration:2.4s; } }`;
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
    node.classList.toggle("settle", settle && !reduce.matches);
    node.style.transform = `translateY(${Math.round(distance - 56)}px)`;
    node.style.opacity = String(Math.min(1, distance / THRESHOLD));
    node.toggleAttribute("data-armed", distance >= THRESHOLD);
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
    if (pull < THRESHOLD) return reset();
    start = null;
    // Pages with unsaved edits cancel this; the pull just springs back.
    if (!dispatchEvent(new Event("whim:refresh", { cancelable: true }))) return reset();
    refreshing = true;
    show(THRESHOLD, true);
    indicator().setAttribute("data-busy", "");
    location.reload();
  });
  addEventListener("touchcancel", () => { if (start) reset(); });
  // Coming back from the bfcache after a reload attempt should not leave a spinner behind.
  addEventListener("pageshow", () => {
    refreshing = false;
    pull = 0;
    if (el) { el.removeAttribute("data-busy"); show(0); }
  });
})();

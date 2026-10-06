/* Shared Motion runtime. CSS declares destinations; Motion owns timing and interruption. */
(() => {
  const engine = window.Motion;
  if (!engine) return;
  const ease = [.22, 1, .36, 1];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const hover = matchMedia("(hover: hover)");
  const nodes = new Map();
  const pending = new Set();
  const active = new Set();
  const spinners = new Map();
  const cleanups = new Map();
  const tipStates = new WeakMap();
  const foldStates = new WeakMap();
  const selector = 'button, .btn, a.nav-link, .brand, .mobile-tabs a, .tier, .pick, .pick img, .zoom, .zoom img, .zoom-hint, summary, [role="tab"], .fade, .profile-change .icon, .log-details .icon, .photo-stack img, .ref .remove, .dropzone, .dropzone-quiet, .read-text, .cost-tick, .cost-thumb, .cost-scale, .reel-card, .reel-card a, .reel-card span, .to-top';
  const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  function track(controls, targets, keys, finish) {
    const record = { controls, targets, keys };
    active.add(record);
    const stop = controls.stop.bind(controls), cancel = controls.cancel.bind(controls);
    controls.stop = () => { active.delete(record); stop(); };
    controls.cancel = () => { active.delete(record); cancel(); };
    controls.finished.then(() => {
      if (!active.delete(record)) return;
      finish?.();
    });
    return controls;
  }
  function stop(target, keys) {
    for (const record of [...active]) {
      if (record.targets.includes(target) && (!keys || keys.some(key => record.keys.includes(key)))) record.controls.stop();
    }
  }
  function isAnimating(target) {
    return [...active].some(record => record.targets.includes(target) && record.controls.state === "running");
  }
  function animate(target, values, options = {}) {
    const { onFinish, ...transition } = options;
    const keys = Object.keys(values);
    stop(target, keys);
    // Native CSS animations avoid stale transform caches when CSS states change.
    const run = target instanceof Element && !keys.some(key => key.startsWith("--")) ? engine.animateMini : engine.animate;
    return track(run(target, values, { duration: .24, ease, ...transition, duration: reduce.matches ? 0 : (transition.duration ?? .24), delay: reduce.matches ? 0 : (transition.delay ?? 0) }), [target], keys, onFinish);
  }
  function sequence(segments, finish) {
    const targets = [...new Set(segments.map(([target]) => target))];
    const keys = [...new Set(segments.flatMap(([, values]) => Object.keys(values)))];
    for (const target of targets) stop(target, keys);
    // Coordinate native Motion animations without retaining transform/layout
    // caches between rapidly reversed photo swaps. Segment offsets are seconds.
    const parts = segments.map(([target, values, { at = 0, ...options } = {}]) => engine.animateMini(target, values, {
      ease, ...options, duration: reduce.matches ? 0 : (options.duration ?? .24), delay: reduce.matches ? 0 : at,
    }));
    const controls = {
      get state() { return parts.some(part => part.state === "running") ? "running" : parts[0].state; },
      finished: Promise.all(parts.map(part => part.finished)),
      stop() { parts.forEach(part => part.stop()); },
      cancel() { parts.forEach(part => part.cancel()); },
      complete() { parts.forEach(part => part.complete()); },
    };
    return track(controls, targets, keys, finish);
  }
  function enter(el, sheet = false) {
    if (reduce.matches || el.hidden) return;
    const base = getComputedStyle(el).transform;
    const original = el.style.transform;
    const start = (base === "none" ? "" : base + " ") + `translateY(${sheet ? el.offsetHeight : 6}px)`;
    animate(el, { opacity: [0, 1], transform: [start, base] }, {
      duration: sheet ? .36 : .24,
      onFinish: () => { el.style.removeProperty("opacity"); if (original) el.style.transform = original; else el.style.removeProperty("transform"); },
    });
  }

  function register(root) {
    if (!(root instanceof Element)) return;
    for (const detail of [root, ...root.querySelectorAll("details.category, details.fold")]) {
      if (detail.matches("details.category, details.fold") && !foldStates.has(detail)) foldStates.set(detail, detail.open);
    }
    const targets = [...root.querySelectorAll(selector)];
    if (root.matches(selector)) targets.unshift(root);
    for (const el of targets) {
      if (nodes.has(el)) continue;
      const css = getComputedStyle(el);
      const properties = new Map();
      for (const spec of css.getPropertyValue("--motion").split(/,(?![^()]*\))/)) {
        const [property, time] = spec.trim().split(/\s+/);
        // The reel's bounded bokeh filter is animated through Motion's native CSS
        // path. Avoid animating shadows and layout properties in generic feedback.
        if (!/^(transform|translate|opacity|filter|background(?:-color)?|border-color|outline-color|color)$/.test(property)) continue;
        const duration = parseFloat(time) * (time?.endsWith("ms") ? .001 : 1);
        properties.set(property === "background" ? "background-color" : property, Number.isFinite(duration) ? duration : .24);
      }
      if (!properties.size) continue;
      const original = new Map([...properties.keys()].map(p => [p, el.style.getPropertyValue(p)]));
      const values = new Map([...properties.keys()].map(p => [p, css.getPropertyValue(p)]));
      nodes.set(el, { properties, original, values });
    }
    const spinning = [...root.querySelectorAll(".spinner")];
    if (root.matches(".spinner")) spinning.push(root);
    for (const el of spinning) if (!spinners.has(el)) {
      const controls = engine.animateMini(el, { transform: ["rotate(0deg)", "rotate(360deg)"] }, { duration: .8, repeat: Infinity, ease: "linear" });
      if (reduce.matches || document.hidden) controls.pause();
      spinners.set(el, controls);
    }
    if (root.matches(".toast")) enter(root);
  }

  function restore(el, state) {
    for (const [p, value] of state.original) {
      if (value) el.style.setProperty(p, value);
      else el.style.removeProperty(p);
    }
    el.style.removeProperty("visibility");
  }
  function sync(el) {
    const state = nodes.get(el);
    if (!state || !el.isConnected) return;
    // Read the current visual state before temporarily releasing our inline overrides.
    const currentCSS = getComputedStyle(el);
    const animating = state.controls?.state === "running";
    const current = new Map([...state.properties.keys()].map(p => [p, animating ? currentCSS.getPropertyValue(p) : state.values.get(p)]));
    // Temporarily detach native effects to read CSS destinations without cancelling
    // an unchanged animation or restarting its easing curve.
    const effects = el.getAnimations().map(animation => [animation, animation.effect]);
    for (const [animation] of effects) animation.effect = null;
    restore(el, state);
    const targetCSS = getComputedStyle(el);
    const target = new Map([...state.properties.keys()].map(p => [p, targetCSS.getPropertyValue(p)]));
    const visibility = targetCSS.visibility;
    for (const [animation, effect] of effects) animation.effect = effect;
    const changed = [...target].some(([p, value]) => state.values.get(p) !== value);
    state.values = target;
    if (!changed) {
      // Keep an in-flight tween intact when an unrelated event reaches the element.
      if (animating) for (const [p, value] of current) el.style.setProperty(p, value);
      return;
    }
    stop(el, [...state.properties.keys()].map(camel));
    restore(el, state);
    if (reduce.matches || el.hidden) return;
    const frames = {};
    let duration = 0;
    for (const [p, value] of target) {
      if (current.get(p) === value) continue;
      frames[camel(p)] = [current.get(p), value];
      duration = Math.max(duration, state.properties.get(p));
    }
    if (!duration) return;
    if (visibility === "hidden") el.style.visibility = "visible";
    state.controls = animate(el, frames, { duration, onFinish: () => restore(el, state) });
  }

  let queued = false;
  function schedule(root) {
    if (!(root instanceof Element)) return;
    if (nodes.has(root)) pending.add(root);
    for (const el of root.querySelectorAll(selector)) if (nodes.has(el)) pending.add(el);
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const el of pending) sync(el);
      pending.clear();
    });
  }
  function interaction(e) {
    if (!(e.target instanceof Element)) return;
    const zone = e.target.closest(".reel-track, .photo-stack, .ref, .zoom, .cost-row, .cost-slider, .profile-change, .pick");
    if (zone) schedule(zone);
    for (let el = e.target; el; el = el.parentElement) if (nodes.has(el)) pending.add(el);
    schedule(e.target);
    const tip = e.target.closest("[data-tip]");
    if (tip) {
      queueMicrotask(() => {
        const on = (hover.matches && tip.matches(":hover")) || tip.matches(":focus-visible");
        if (tipStates.get(tip) === on) return;
        tipStates.set(tip, on);
        animate(tip, { "--tip-opacity": on ? 1 : 0, "--tip-y": on ? "0px" : "4px" }, { delay: on && !reduce.matches ? .4 : 0 });
      });
    }
  }
  for (const event of ["pointerover", "pointerout", "pointerdown", "pointerup", "pointercancel", "focusin", "focusout", "keydown", "keyup", "change"]) {
    document.addEventListener(event, interaction, true);
  }
  function fold(el) {
    if (!el.matches("details.category, details.fold")) return;
    const before = foldStates.get(el);
    if (before === el.open) return;
    foldStates.set(el, el.open);
    const summary = el.querySelector("summary"), css = getComputedStyle(summary);
    const angle = isAnimating(summary) ? css.getPropertyValue("--fold-angle") : (before ? "-135deg" : "45deg");
    const y = isAnimating(summary) ? css.getPropertyValue("--fold-y") : (before ? "2px" : "-2px");
    animate(summary, { "--fold-angle": [angle, el.open ? "-135deg" : "45deg"], "--fold-y": [y, el.open ? "2px" : "-2px"] }, { duration: .2 });
  }
  document.addEventListener("toggle", e => { fold(e.target); schedule(e.target); }, true);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "childList") {
        for (const added of record.addedNodes) register(added);
      } else {
        const el = record.target;
        schedule(el);
        if (record.attributeName === "open") {
          fold(el);
          if (el.matches("dialog[open]")) enter(el, el.matches(".modal") && matchMedia("(max-width:860px)").matches);
        }
        if (record.attributeName === "hidden" && !el.hidden && el.matches(".savebar, [data-panel]")) enter(el);
      }
    }
    // Detached views must not retain tweens or perpetual clocks.
    for (const record of [...active]) if (record.targets.some(target => target instanceof Element && !target.isConnected)) record.controls.stop();
    for (const [el] of nodes) if (!el.isConnected) { stop(el); nodes.delete(el); }
    for (const [el, tween] of spinners) if (!el.isConnected) { tween.stop(); spinners.delete(el); }
    for (const [el, dispose] of cleanups) if (!el.isConnected) { dispose(); cleanups.delete(el); }
  });
  register(document.body);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "open", "data-collapsed", "data-selected", "aria-selected", "aria-pressed", "aria-expanded"] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  function spinnerState() {
    for (const tween of spinners.values()) {
      if (reduce.matches || document.hidden) tween.pause(); else tween.play();
    }
  }
  document.addEventListener("visibilitychange", spinnerState);
  reduce.addEventListener("change", () => {
    if (reduce.matches) {
      for (const record of [...active]) record.controls.complete();
    }
    spinnerState();
  });

  let scrollTween;
  function scroll(top) {
    scrollTween?.stop();
    if (reduce.matches) return window.scrollTo({ top, behavior: "instant" });
    const controls = engine.animate(scrollY, top, { duration: .5, ease, onUpdate: y => window.scrollTo({ top: y, behavior: "instant" }) });
    scrollTween = track(controls, [window], ["scrollY"]);
  }
  // User input always takes back control of scrolling.
  for (const event of ["wheel", "touchstart", "pointerdown"]) addEventListener(event, () => scrollTween?.stop(), { passive: true });
  addEventListener("keydown", e => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) scrollTween?.stop(); });
  window.whimMotion = { animate, sequence, reduce, enter, scroll, stop, isAnimating, frame: engine.frame, cancelFrame: engine.cancelFrame, own(el, dispose) { cleanups.get(el)?.(); cleanups.set(el, dispose); } };
})();

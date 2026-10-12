import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../src/app/index.html", import.meta.url), "utf8");
const routeSource = html.slice(html.indexOf("async function loadView()"), html.indexOf("\nconst sidebarScroller"));
const shellSource = html.slice(html.indexOf('const SHELL_CACHE ='), html.indexOf('// A reload restores only sidebar summaries'));
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}
function routeContext(api: (path: string) => Promise<unknown>) {
  const context = vm.createContext({
    api, loadSeq: 1, location: { search: "?listing=first" }, URLSearchParams, structuredClone,
    state: { listings: [], profiles: [], tasteProfiles: [] }, clearTimeout,
    pollTimer: null, runningTimer: null, stopReel: vi.fn(),
    refreshShell: vi.fn(async () => {}), renderMobileTabs: vi.fn(), renderListings: vi.fn(),
    renderProfilesNav: vi.fn(), renderListing: vi.fn(), renderTaste: vi.fn(), renderSettings: vi.fn(),
    renderHome: vi.fn(), renderReports: vi.fn(), renderCollection: vi.fn(), pollJob: vi.fn(),
    setParams: vi.fn(), $: vi.fn(() => ({ innerHTML: "", dataset: {} })), esc: String,
  });
  vm.runInContext(routeSource, context);
  return context;
}

describe("app shell navigation", () => {
  it("starts page data while the shared shell is still loading", async () => {
    const shell = deferred(), page = deferred();
    const api = vi.fn(() => page.promise);
    const ctx = routeContext(api);
    ctx.refreshShell = vi.fn(() => shell.promise);
    const loading = vm.runInContext("loadView()", ctx);
    expect(api).toHaveBeenCalledWith("/api/listings/first");
    page.resolve({ id: "first", activeJob: null });
    shell.resolve(undefined);
    await loading;
    expect(ctx.renderListing).toHaveBeenCalledOnce();
  });
  it("ignores a slow older route after a newer navigation has rendered", async () => {
    const first = deferred();
    const ctx = routeContext(path => path.endsWith("first") ? first.promise : Promise.resolve({ id: "second", activeJob: null }));
    const old = vm.runInContext("loadView()", ctx);
    ctx.loadSeq = 2; ctx.location.search = "?listing=second";
    await vm.runInContext("loadView()", ctx);
    first.resolve({ id: "first", activeJob: null });
    await old;
    expect(ctx.state.listing.id).toBe("second");
    expect(ctx.renderListing).toHaveBeenCalledOnce();
  });
  it("loads Reports with two parallel requests and no listing-detail fan-out", async () => {
    const api = vi.fn(async path => path === "/api/reports" ? [{ id: "report" }] : []);
    const ctx = routeContext(api); ctx.location.search = "?view=reports";
    await vm.runInContext("loadView()", ctx);
    expect(api.mock.calls.map(call => call[0])).toEqual(["/api/reports", "/api/running"]);
    expect(ctx.state.reports).toEqual([{ id: "report" }]);
  });
  it("deduplicates shared requests and reuses fresh shell data", async () => {
    const held = deferred();
    const api = vi.fn(async path => { await held.promise; return path === "/api/status" ? { keysError: null } : []; });
    const ctx = vm.createContext({ api, state: {}, Date, Promise, setTimeout, clearTimeout,
      loadProfiles: vi.fn(async () => []), updateBanner: vi.fn(), renderListings: vi.fn(),
      renderProfilesNav: vi.fn(), localStorage: { setItem: vi.fn() } });
    vm.runInContext(shellSource, ctx);
    const one = vm.runInContext("refreshShell()", ctx), two = vm.runInContext("refreshShell()", ctx);
    held.resolve(undefined); await Promise.all([one, two]);
    await vm.runInContext("refreshShell()", ctx);
    expect(api).toHaveBeenCalledTimes(3);
    expect(ctx.loadProfiles).toHaveBeenCalledOnce();
    expect(ctx.renderListings).toHaveBeenCalledOnce();
  });
});

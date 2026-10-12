import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
const html = readFileSync(new URL("../src/app/index.html", import.meta.url), "utf8");
const start = html.indexOf('  // Preserve the press-time state:');
const source = html.slice(start, html.indexOf('  form.addEventListener("change",', start));
function setup() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const buttons = ["taste", "scope"].map(id => ({
    expanded: "false", focus: vi.fn(),
    getAttribute(name: string) { return name === "aria-expanded" ? this.expanded : id; },
    setAttribute(_name: string, value: string) { this.expanded = value; },
  }));
  const menus = { taste: { hidden: true }, scope: { hidden: true } };
  const input = { focus: vi.fn() };
  const closeMenus = () => { buttons.forEach(b => b.expanded = "false"); menus.taste.hidden = menus.scope.hidden = true; };
  const ctx = vm.createContext({ form: { addEventListener: (name: string, fn: (e: unknown) => void) => handlers[name] = fn }, closeMenus,
    $: (selector: string) => selector.startsWith("#") ? menus[selector.slice(1) as keyof typeof menus] : input });
  vm.runInContext(source, ctx);
  const event = (button: typeof buttons[number], detail = 1) => ({ button: 0, detail, target: { matches: () => false, closest: () => button } });
  return { buttons, menus, handlers, closeMenus, event, input };
}
it("closes either picker even if focus dismisses it between pointerdown and click", () => {
  const s = setup();
  for (const button of s.buttons) {
    s.handlers.pointerdown!(s.event(button)); s.handlers.click!(s.event(button));
    expect(button.expanded).toBe("true");
    s.handlers.pointerdown!(s.event(button));
    s.closeMenus(); // Reproduce focus dismissal before click, as on Safari.
    s.handlers.click!(s.event(button));
    expect(button.expanded).toBe("false");
    expect(Object.values(s.menus).every(menu => menu.hidden)).toBe(true);
  }
  expect(s.input.focus).not.toHaveBeenCalled();
});
it("switches pickers and preserves keyboard opening", () => {
  const s = setup();
  s.handlers.click!(s.event(s.buttons[0]!, 0));
  expect(s.input.focus).toHaveBeenCalledOnce();
  s.handlers.pointerdown!(s.event(s.buttons[1]!)); s.handlers.click!(s.event(s.buttons[1]!));
  expect(s.buttons.map(b => b.expanded)).toEqual(["false", "true"]);
});

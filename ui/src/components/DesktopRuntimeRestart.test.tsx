// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopRuntimeRestart } from "./DesktopRuntimeRestart";

const state = vi.hoisted(() => ({ shell: null as null | { restart: () => Promise<void> } }));
vi.mock("@/lib/desktop-shell", () => ({ readDesktopShell: () => state.shell }));
vi.mock("@/context/I18nContext", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
function render(disabled = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<DesktopRuntimeRestart disabled={disabled} />));
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  state.shell = null;
});

describe("DesktopRuntimeRestart", () => {
  it("hides the action in a browser", () => {
    render();
    expect(container.textContent).toBe("");
  });

  it("blocks restart while an update is running", () => {
    const restart = vi.fn();
    state.shell = { restart };
    render(true);
    act(() => container.querySelector("button")!.click());
    expect(restart).not.toHaveBeenCalled();
  });

  it("prevents duplicate restarts and restores retry after failure", async () => {
    let reject!: (cause: Error) => void;
    const restart = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }))
      .mockResolvedValueOnce(undefined);
    state.shell = { restart };
    render();
    const button = container.querySelector("button")!;
    act(() => { button.click(); button.click(); });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("about.restart.pending");
    await act(async () => reject(new Error("Shutdown unavailable")));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Shutdown unavailable");
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(restart).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

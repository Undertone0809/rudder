// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function ShortcutHarness({ onNavigateBack }: { onNavigateBack: () => boolean }) {
  useKeyboardShortcuts({ onNavigateBack });
  return <div />;
}

async function renderShortcutHarness(onNavigateBack: () => boolean) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ShortcutHarness onNavigateBack={onNavigateBack} />);
    await Promise.resolve();
  });
}

function dispatchEscape() {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

describe("useKeyboardShortcuts", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = "";
  });

  it("navigates back on plain Escape when no Escape layer is open", async () => {
    const onNavigateBack = vi.fn(() => true);
    await renderShortcutHarness(onNavigateBack);

    const event = dispatchEscape();

    expect(onNavigateBack).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets open menus and listboxes handle Escape before back navigation", async () => {
    const onNavigateBack = vi.fn(() => true);
    await renderShortcutHarness(onNavigateBack);

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    expect(dispatchEscape().defaultPrevented).toBe(false);

    menu.remove();
    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    document.body.append(listbox);
    expect(dispatchEscape().defaultPrevented).toBe(false);

    expect(onNavigateBack).not.toHaveBeenCalled();
  });
});

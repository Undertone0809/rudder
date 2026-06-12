// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import type { KeyboardShortcutSettings } from "@rudderhq/shared";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function ShortcutHarness({
  onNavigateBack,
  onNewIssue,
  shortcutSettings,
}: {
  onNavigateBack?: () => boolean;
  onNewIssue?: () => void;
  shortcutSettings?: KeyboardShortcutSettings | null;
}) {
  useKeyboardShortcuts({ onNavigateBack, onNewIssue, shortcutSettings });
  return <div />;
}

async function renderShortcutHarness(handlers: {
  onNavigateBack?: () => boolean;
  onNewIssue?: () => void;
  shortcutSettings?: KeyboardShortcutSettings | null;
}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ShortcutHarness {...handlers} />);
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

function dispatchEscapeFrom(target: HTMLElement) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchKey(key: string, init: KeyboardEventInit = {}, target: EventTarget = document) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
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
    await renderShortcutHarness({ onNavigateBack });

    const event = dispatchEscape();

    expect(onNavigateBack).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets open menus and listboxes handle Escape before back navigation", async () => {
    const onNavigateBack = vi.fn(() => true);
    await renderShortcutHarness({ onNavigateBack });

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

  it("navigates back on Escape from editable content when no inner layer handled it", async () => {
    const onNavigateBack = vi.fn(() => true);
    await renderShortcutHarness({ onNavigateBack });

    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(editable);

    const event = dispatchEscapeFrom(editable);

    expect(onNavigateBack).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens a new issue on Command+N and suppresses the browser shortcut", async () => {
    const onNewIssue = vi.fn();
    await renderShortcutHarness({ onNewIssue });

    const event = dispatchKey("n", { metaKey: true });

    expect(onNewIssue).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not open a new issue from editable fields", async () => {
    const onNewIssue = vi.fn();
    await renderShortcutHarness({ onNewIssue });
    const input = document.createElement("input");
    document.body.append(input);

    const event = dispatchKey("n", { metaKey: true }, input);

    expect(onNewIssue).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("uses configured shortcut bindings and respects disabled actions", async () => {
    const onNewIssue = vi.fn();
    await renderShortcutHarness({
      onNewIssue,
      shortcutSettings: {
        shortcuts: [
          {
            actionId: "issue.create",
            bindings: [{ key: "i", metaKey: true }],
          },
        ],
      },
    });

    expect(dispatchKey("c").defaultPrevented).toBe(false);
    expect(dispatchKey("i", { metaKey: true }).defaultPrevented).toBe(true);
    expect(onNewIssue).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(
        <ShortcutHarness
          onNewIssue={onNewIssue}
          shortcutSettings={{ shortcuts: [{ actionId: "issue.create", disabled: true }] }}
        />,
      );
    });

    expect(dispatchKey("i", { metaKey: true }).defaultPrevented).toBe(false);
    expect(onNewIssue).toHaveBeenCalledTimes(1);
  });
});

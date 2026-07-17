// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabContextMenu } from "./WorkspaceTabContextMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkspaceTabContextMenu", () => {
  let container: HTMLDivElement;
  let root: Root;
  const handlers = {
    onClose: vi.fn(),
    onCopyLink: vi.fn(),
    onCopyAbsolutePath: vi.fn(),
    onOpenInIde: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseOtherTabs: vi.fn(),
    onCloseTabsToRight: vi.fn(),
    onCloseAllTabs: vi.fn(),
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.values(handlers).forEach((handler) => handler.mockReset());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderMenu(overrides: Partial<Parameters<typeof WorkspaceTabContextMenu>[0]> = {}) {
    act(() => root.render(
      <WorkspaceTabContextMenu
        menu={{ filePath: "notes.md", left: 20, top: 30 }}
        ideLabel="Cursor"
        canOpenInIde
        canCloseOtherTabs
        canCloseTabsToRight
        {...handlers}
        {...overrides}
      />,
    ));
  }

  it("renders nothing without menu state and preserves disabled commands", () => {
    renderMenu({ menu: null });
    expect(document.querySelector("[data-testid='org-workspaces-tab-context-menu']")).toBeNull();

    renderMenu({ canOpenInIde: false, canCloseOtherTabs: false, canCloseTabsToRight: false });
    expect(button("Open in Cursor").disabled).toBe(true);
    expect(button("Close others").disabled).toBe(true);
    expect(button("Close tabs to the right").disabled).toBe(true);
  });

  it("delegates every file command and closes the menu", () => {
    const commands = [
      ["Copy link", handlers.onCopyLink],
      ["Copy absolute path", handlers.onCopyAbsolutePath],
      ["Open in Cursor", handlers.onOpenInIde],
      ["Close", handlers.onCloseTab],
      ["Close others", handlers.onCloseOtherTabs],
      ["Close tabs to the right", handlers.onCloseTabsToRight],
    ] as const;

    for (const [label, handler] of commands) {
      renderMenu();
      act(() => button(label).click());
      expect(handler).toHaveBeenLastCalledWith("notes.md");
    }
    expect(handlers.onClose).toHaveBeenCalledTimes(commands.length);

    renderMenu();
    act(() => button("Close all").click());
    expect(handlers.onCloseAllTabs).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledTimes(commands.length + 1);
  });
});

function button(label: string) {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

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
    expect(menuItem("Open in Cursor").hasAttribute("data-disabled")).toBe(true);
    expect(menuItem("Close others").hasAttribute("data-disabled")).toBe(true);
    expect(menuItem("Close tabs to the right").hasAttribute("data-disabled")).toBe(true);
  });

  it("delegates every file command and closes the menu", () => {
    const commands = [
      ["Open in Cursor", handlers.onOpenInIde],
      ["Close", handlers.onCloseTab],
      ["Close others", handlers.onCloseOtherTabs],
      ["Close tabs to the right", handlers.onCloseTabsToRight],
    ] as const;

    for (const [label, handler] of commands) {
      renderMenu();
      act(() => menuItem(label).click());
      expect(handler).toHaveBeenLastCalledWith("notes.md");
    }
    expect(handlers.onClose).toHaveBeenCalledTimes(commands.length);

    renderMenu();
    act(() => menuItem("Close all").click());
    expect(handlers.onCloseAllTabs).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledTimes(commands.length + 1);
  });

  it("reveals the concrete copy commands in a submenu", () => {
    renderMenu();

    expect(menuItem("Copy")).toBeTruthy();
    expect(findMenuItem("Copy link")).toBeUndefined();
    expect(findMenuItem("Copy absolute path")).toBeUndefined();

    openCopySubmenu();
    expect(menuItem("Copy link")).toBeTruthy();
    expect(menuItem("Copy absolute path")).toBeTruthy();

    act(() => menuItem("Copy link").click());
    expect(handlers.onCopyLink).toHaveBeenLastCalledWith("notes.md");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    renderMenu();
    openCopySubmenu();
    act(() => menuItem("Copy absolute path").click());
    expect(handlers.onCopyAbsolutePath).toHaveBeenLastCalledWith("notes.md");
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
  });
});

function findMenuItem(label: string) {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
    .find((candidate) => candidate.textContent?.trim() === label);
}

function menuItem(label: string) {
  const match = findMenuItem(label);
  if (!match) throw new Error(`Missing menu item: ${label}`);
  return match;
}

function openCopySubmenu() {
  const trigger = menuItem("Copy");
  act(() => {
    trigger.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

// @vitest-environment jsdom

import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceContextHeader,
  WorkspaceContextSidebar,
  WorkspaceSidebarCollapseButton,
} from "./WorkspaceContextSidebar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mountedRoots.push({ container, root });
  return container;
}

afterEach(() => {
  for (const { container, root } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("workspace sidebar primitives", () => {
  it("forwards native sidebar props and ref while providing the default root", () => {
    const asideRef = createRef<HTMLElement>();
    const container = render(
      <WorkspaceContextSidebar
        ref={asideRef}
        id="files-sidebar"
        aria-label="Workspace files"
        className="files-sidebar-extra"
      >
        <span>Files</span>
      </WorkspaceContextSidebar>,
    );

    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside?.dataset.testid).toBe("workspace-sidebar");
    expect(aside?.id).toBe("files-sidebar");
    expect(aside?.getAttribute("aria-label")).toBe("Workspace files");
    expect(aside?.classList.contains("workspace-context-sidebar")).toBe(true);
    expect(aside?.classList.contains("files-sidebar-extra")).toBe(true);
    expect(asideRef.current).toBe(aside);
    expect(aside?.textContent).toBe("Files");
  });

  it("keeps header content caller-owned and enables drag only by caller class", () => {
    const container = render(
      <>
        <WorkspaceContextHeader aria-label="Files header">
          <div data-testid="header-title-slot">Files</div>
          <div data-testid="header-actions-slot">Actions</div>
        </WorkspaceContextHeader>
        <WorkspaceContextHeader className="desktop-window-drag">
          <h2>Messenger</h2>
        </WorkspaceContextHeader>
      </>,
    );

    const [filesHeader, messengerHeader] = Array.from(container.querySelectorAll("header"));
    expect(filesHeader?.dataset.testid).toBe("workspace-context-header");
    expect(filesHeader?.getAttribute("aria-label")).toBe("Files header");
    expect(Array.from(filesHeader?.children ?? []).map((child) => child.tagName)).toEqual([
      "DIV",
      "DIV",
    ]);
    expect(filesHeader?.querySelector("[data-testid='header-title-slot']")?.textContent).toBe("Files");
    expect(filesHeader?.classList.contains("desktop-window-drag")).toBe(false);
    expect(messengerHeader?.classList.contains("desktop-window-drag")).toBe(true);
  });

  it("uses the default collapse control and calls the supplied handler", () => {
    const onClick = vi.fn();
    const container = render(
      <>
        <WorkspaceSidebarCollapseButton onClick={onClick} />
        <WorkspaceSidebarCollapseButton
          className="shrink"
          onClick={vi.fn()}
          aria-label="Hide files sidebar"
          title="Hide files sidebar"
          data-testid="collapse-files-sidebar"
        />
      </>,
    );

    const [button, customizedButton] = container.querySelectorAll<HTMLButtonElement>("button");
    expect(button?.type).toBe("button");
    expect(button?.getAttribute("aria-label")).toBe("Collapse workspace sidebar");
    expect(button?.title).toBe("Collapse workspace sidebar");
    expect(button?.classList.contains("desktop-window-no-drag")).toBe(true);
    expect(button?.querySelector(".lucide-panel-left")).not.toBeNull();
    expect(button?.querySelector(".lucide-panel-left")?.classList.contains("h-4")).toBe(true);
    expect(button?.querySelector(".lucide-panel-left")?.classList.contains("w-4")).toBe(true);
    expect(customizedButton?.getAttribute("aria-label")).toBe("Hide files sidebar");
    expect(customizedButton?.title).toBe("Hide files sidebar");
    expect(customizedButton?.dataset.testid).toBe("collapse-files-sidebar");
    expect(customizedButton?.classList.contains("shrink")).toBe(true);
    expect(customizedButton?.classList.contains("shrink-0")).toBe(false);

    act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

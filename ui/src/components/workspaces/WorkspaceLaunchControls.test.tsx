// @vitest-environment jsdom

import type { DesktopWorkspaceLaunchTarget } from "@/lib/desktop-shell";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLaunchMenu, WorkspaceLaunchTargetIcon } from "./WorkspaceLaunchControls";

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children, align }: { children: ReactNode; align?: string }) => <div data-align={align}>{children}</div>,
  DropdownMenuItem: ({ children, disabled, onSelect, ...props }: { children: ReactNode; disabled?: boolean; onSelect?: () => void }) => (
    <button type="button" disabled={disabled} onClick={onSelect} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

const cursorTarget: DesktopWorkspaceLaunchTarget = {
  id: "cursor",
  label: "Cursor",
  kind: "ide",
  iconDataUrl: "data:image/png;base64,native",
};

describe("WorkspaceLaunchTargetIcon", () => {
  it("falls back from a native Cursor icon to its brand asset and then the generic IDE icon", () => {
    const container = render(<WorkspaceLaunchTargetIcon target={cursorTarget} />);
    const nativeImage = container.querySelector<HTMLImageElement>("img");
    expect(nativeImage?.src).toContain("data:image/png;base64,native");
    expect(container.querySelector('[data-fallback-icon="true"]')).toBeNull();

    act(() => nativeImage?.dispatchEvent(new Event("error")));
    const brand = container.querySelector<HTMLImageElement>('[data-brand-fallback="true"] img');
    expect(brand?.getAttribute("src")).toBe("/brands/cursor-app-icon.svg");

    act(() => brand?.dispatchEvent(new Event("error")));
    expect(container.querySelector('[data-fallback-icon="true"] svg')).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("uses app-specific and file-target fallbacks with the original target identity", () => {
    const vscode: DesktopWorkspaceLaunchTarget = { id: "vscode", label: "VS Code", kind: "ide" };
    const first = render(<WorkspaceLaunchTargetIcon target={vscode} className="custom-slot" />);
    expect(first.querySelector('[data-workspace-launch-target-icon="vscode"]')?.textContent).toBe("VS");
    expect(first.querySelector('[data-app-specific-fallback="true"]')?.classList.contains("custom-slot")).toBe(true);

    act(() => root?.unmount());
    root = null;
    const second = render(
      <WorkspaceLaunchTargetIcon target={{ fileTarget: true, id: "defaultApp", label: "Default app", kind: "app" }} />,
    );
    expect(second.querySelector('[data-workspace-launch-target-icon="defaultApp"] svg')).toBeTruthy();
  });
});

describe("WorkspaceLaunchMenu", () => {
  it("renders nothing without available targets", () => {
    const container = render(
      <WorkspaceLaunchMenu rootPath="/repo" targets={[]} openingTargetId={null} onOpenTarget={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("lists targets and sends the selected target with workspace context", () => {
    const onOpenTarget = vi.fn();
    const targets: DesktopWorkspaceLaunchTarget[] = [
      cursorTarget,
      { id: "terminal", label: "Terminal", kind: "terminal" },
    ];
    const container = render(
      <WorkspaceLaunchMenu
        rootPath="/repo"
        targets={targets}
        openingTargetId={null}
        onOpenTarget={onOpenTarget}
        contentAlign="start"
        testId="launch"
        targetTestIdPrefix="target"
      />,
    );

    expect(container.querySelector('[data-align="start"]')).toBeTruthy();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="launch"]')?.disabled).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="target-terminal"]')?.click());
    expect(onOpenTarget).toHaveBeenCalledWith("/repo", targets[1], "workspace");
  });

  it("disables the launcher and every target while an open is pending", () => {
    const targets: DesktopWorkspaceLaunchTarget[] = [
      cursorTarget,
      { id: "terminal", label: "Terminal", kind: "terminal" },
    ];
    const container = render(
      <WorkspaceLaunchMenu rootPath="/repo" targets={targets} openingTargetId="terminal" onOpenTarget={vi.fn()} />,
    );

    expect(container.querySelector<HTMLButtonElement>('[data-testid="org-workspaces-launcher"]')?.disabled).toBe(true);
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid^="org-workspaces-launch-target-"]')).every((button) => button.disabled)).toBe(true);
    expect(container.querySelector('[data-testid="org-workspaces-launch-target-terminal"] .animate-spin')).toBeTruthy();
  });
});

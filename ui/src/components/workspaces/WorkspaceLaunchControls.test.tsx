// @vitest-environment jsdom

import type { DesktopWorkspaceLaunchTarget } from "@/lib/desktop-shell";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as workspaceLaunchControls from "./WorkspaceLaunchControls";
import {
  UnsupportedWorkspaceFileLauncher,
  WorkspaceLaunchMenu,
  WorkspaceLaunchTargetIcon,
} from "./WorkspaceLaunchControls";

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
  TooltipContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
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

describe("UnsupportedWorkspaceFileLauncher", () => {
  it("is available as a reusable launcher surface", () => {
    expect("UnsupportedWorkspaceFileLauncher" in workspaceLaunchControls).toBe(true);
  });

  it("shows honest centered fallback copy without controls when no targets are available", () => {
    const container = render(
      <UnsupportedWorkspaceFileLauncher
        targets={[]}
        currentTarget={null}
        openingTargetId={null}
        onOpenTarget={vi.fn()}
      />,
    );

    expect(container.textContent).toContain("This file can’t be previewed or edited in Rudder.");
    expect(container.querySelector('[data-testid="org-workspaces-unsupported-file-launcher"]')).toBeNull();
    expect(container.firstElementChild?.className).toContain("items-center");
    expect(container.firstElementChild?.className).toContain("justify-center");
  });

  it("renders a compact split action with target icons, labels, and accessible names", () => {
    const targets = [
      { fileTarget: true as const, id: "defaultApp" as const, label: "Default app", kind: "app" as const },
      { fileTarget: true as const, id: "vscode" as const, label: "VS Code", kind: "ide" as const, workspaceTarget: { id: "vscode" as const, label: "VS Code", kind: "ide" as const } },
      { id: "finder" as const, label: "Finder", kind: "folder" as const },
    ];
    const onOpenTarget = vi.fn();
    const container = render(
      <UnsupportedWorkspaceFileLauncher
        targets={targets}
        currentTarget={targets[0]}
        openingTargetId={null}
        onOpenTarget={onOpenTarget}
      />,
    );

    const primary = container.querySelector<HTMLButtonElement>('[data-testid="org-workspaces-unsupported-file-open-current"]');
    const menu = container.querySelector<HTMLButtonElement>('[data-testid="org-workspaces-unsupported-file-launcher"]');
    expect(primary?.getAttribute("aria-label")).toBe("Open file with Default app");
    expect(menu?.getAttribute("aria-label")).toBe("Choose how to open file");
    expect(Array.from(container.querySelectorAll("span")).find((element) => (
      element.textContent === "Choose how to open file"
    ))?.classList.contains("pointer-events-none")).toBe(true);
    expect(primary?.className).toContain("h-9");
    expect(container.querySelector('[data-workspace-launch-target-icon="defaultApp"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="org-workspaces-unsupported-file-target-vscode"]')?.textContent).toContain("VS Code");
    expect(container.querySelector('[data-testid="org-workspaces-unsupported-file-target-finder"]')?.textContent).toContain("Finder");

    act(() => primary?.click());
    expect(onOpenTarget).toHaveBeenCalledWith(targets[0]);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="org-workspaces-unsupported-file-target-finder"]')?.click());
    expect(onOpenTarget).toHaveBeenLastCalledWith(targets[2]);
  });

  it("disables both split actions and shows a spinner while a launch is pending", () => {
    const target = { fileTarget: true as const, id: "defaultApp" as const, label: "Default app", kind: "app" as const };
    const container = render(
      <UnsupportedWorkspaceFileLauncher
        targets={[target]}
        currentTarget={target}
        openingTargetId="defaultApp"
        onOpenTarget={vi.fn()}
      />,
    );

    expect(container.querySelector<HTMLButtonElement>('[data-testid="org-workspaces-unsupported-file-open-current"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="org-workspaces-unsupported-file-launcher"]')?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="org-workspaces-unsupported-file-open-current"] .animate-spin')).toBeTruthy();
  });
});

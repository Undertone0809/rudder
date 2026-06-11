// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopWindowControls } from "./DesktopWindowControls";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  desktopShell: {
    platform: "win32" as NodeJS.Platform,
    minimizeWindow: vi.fn(),
    toggleMaximizeWindow: vi.fn(),
    closeWindow: vi.fn(),
    isWindowMaximized: vi.fn(),
  },
}));

vi.mock("@/lib/desktop-shell", () => ({
  readDesktopShell: () => mockState.desktopShell,
}));

describe("DesktopWindowControls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockState.desktopShell.platform = "win32";
    mockState.desktopShell.minimizeWindow.mockResolvedValue(undefined);
    mockState.desktopShell.toggleMaximizeWindow.mockResolvedValue(true);
    mockState.desktopShell.closeWindow.mockResolvedValue(undefined);
    mockState.desktopShell.isWindowMaximized.mockResolvedValue(false);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.documentElement.classList.remove("desktop-shell-window-maximized");
    document.body.classList.remove("desktop-shell-window-maximized");
    vi.restoreAllMocks();
  });

  it("renders desktop controls and invokes window actions", async () => {
    await act(async () => {
      root.render(<DesktopWindowControls />);
    });

    const minimize = container.querySelector<HTMLButtonElement>('button[aria-label="Minimize"]');
    const maximize = container.querySelector<HTMLButtonElement>('button[aria-label="Maximize"]');
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');

    expect(minimize).not.toBeNull();
    expect(maximize).not.toBeNull();
    expect(close).not.toBeNull();

    await act(async () => {
      minimize?.click();
      maximize?.click();
      close?.click();
    });

    expect(mockState.desktopShell.minimizeWindow).toHaveBeenCalledTimes(1);
    expect(mockState.desktopShell.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
    expect(mockState.desktopShell.closeWindow).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains("desktop-shell-window-maximized")).toBe(true);
  });

  it("does not render custom controls on macOS desktop shells", async () => {
    mockState.desktopShell.platform = "darwin";

    await act(async () => {
      root.render(<DesktopWindowControls />);
    });

    expect(container.querySelector(".desktop-caption-controls")).toBeNull();
  });

  it("does not render custom controls on Linux desktop shells", async () => {
    mockState.desktopShell.platform = "linux";

    await act(async () => {
      root.render(<DesktopWindowControls />);
    });

    expect(container.querySelector(".desktop-caption-controls")).toBeNull();
  });
});

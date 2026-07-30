// @vitest-environment jsdom

import type { DevServerHealthStatus } from "@/api/health";
import { ToastProvider } from "@/context/ToastContext";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevRestartBanner } from "./DevRestartBanner";
import { ToastViewport } from "./ToastViewport";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseDevServer: DevServerHealthStatus = {
  enabled: true,
  restartRequired: true,
  reason: "backend_changes",
  lastChangedAt: "2026-04-14T03:30:00.000Z",
  changedPathCount: 1,
  changedPathsSample: ["server/src/services/messenger.ts"],
  envFileChanged: false,
  pendingMigrations: [],
  lastRestartAt: "2026-04-14T03:20:00.000Z",
};

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  Reflect.deleteProperty(window, "desktopShell");
});

function renderWithToasts(devServer?: DevServerHealthStatus) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  act(() => {
    root.render(
      <ToastProvider>
        <DevRestartBanner devServer={devServer} />
        <ToastViewport />
      </ToastProvider>,
    );
  });

  return { container, root };
}

describe("DevRestartBanner", () => {
  it("does not render an inline layout banner", () => {
    expect(renderToStaticMarkup(<ToastProvider><DevRestartBanner devServer={baseDevServer} /></ToastProvider>)).toBe("");
  });

  it("shows one warning toast when restart becomes required", async () => {
    renderWithToasts(baseDevServer);

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Restart required");
    expect(document.body.textContent).toContain("Restart pnpm dev after the active work is safe to interrupt.");
    expect(document.body.textContent).toContain("Changed: server/src/services/messenger.ts.");
  });

  it("offers an immediate Desktop restart while keeping the warning persistent", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: { restart },
    });
    renderWithToasts(baseDevServer);

    await act(async () => {
      await Promise.resolve();
    });

    const restartButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Restart Rudder");
    expect(restartButton).toBeDefined();

    await act(async () => {
      restartButton?.click();
      await Promise.resolve();
    });
    expect(restart).toHaveBeenCalledOnce();
  });

  it("keeps the restart action available and reports a Desktop restart failure", async () => {
    const restart = vi.fn().mockRejectedValue(new Error("restart unavailable"));
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: { restart },
    });
    renderWithToasts(baseDevServer);
    await act(async () => {
      await Promise.resolve();
    });

    const restartButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Restart Rudder");
    await act(async () => {
      restartButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Restart required");
    expect(document.body.textContent).toContain("Could not restart Rudder");
    expect(document.body.textContent).toContain("restart unavailable");
  });

  it("describes env-file drift explicitly when .env changed after boot", async () => {
    renderWithToasts({
      ...baseDevServer,
      envFileChanged: true,
      changedPathsSample: [".env"],
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Environment configuration changed since this server booted.");
    expect(document.body.textContent).toContain("Changed: .env.");
  });

  it("does not enqueue duplicate toasts for the same stale state", async () => {
    const { root } = renderWithToasts(baseDevServer);

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      root.render(
        <ToastProvider>
          <DevRestartBanner devServer={baseDevServer} />
          <ToastViewport />
        </ToastProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const text = document.body.textContent ?? "";
    expect(text.match(/Restart required/g)?.length ?? 0).toBe(1);
  });

  it("dismisses the persistent warning after the runtime becomes fresh", async () => {
    const { root } = renderWithToasts(baseDevServer);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Restart required");

    act(() => {
      root.render(
        <ToastProvider>
          <DevRestartBanner devServer={{ ...baseDevServer, restartRequired: false }} />
          <ToastViewport />
        </ToastProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain("Restart required");
  });
});

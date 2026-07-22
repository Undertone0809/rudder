// @vitest-environment jsdom

import type { DesktopLocalAppDefinition, DesktopLocalAppRuntimeView } from "@/lib/desktop-shell";
import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAppPanelView } from "./LocalAppPanelView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const definition: DesktopLocalAppDefinition = {
  id: "definition-a",
  desktopInstallationId: "installation-a",
  appPublicId: "public-a",
  localBindingId: "binding-a",
  title: "Marketing dashboard",
  executable: "/usr/local/bin/npm",
  argv: ["run", "dev"],
  cwd: "/Users/zeeland/projects/uranus/rudder/mkt/dashboard",
  inheritedEnvNames: ["RUDDER_GROWTH_DB_PATH"],
  readiness: { path: "/api/health", timeoutMs: 30_000 },
  openPath: "/outreach",
  trustFingerprint: "trusted-a",
  approvedFingerprint: "trusted-a",
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

const target: Extract<SidePanelTarget, { kind: "local_app" }> = {
  kind: "local_app",
  desktopInstallationId: "installation-a",
  appPublicId: "public-a",
  localBindingId: "binding-a",
  label: "Marketing dashboard",
  viewInstanceId: "view-a",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

const list = vi.fn();
const status = vi.fn();
const start = vi.fn();
const stop = vi.fn();
const logs = vi.fn();
const attestedTarget = vi.fn();

beforeAll(() => {
  notifyManager.setNotifyFunction((callback) => act(callback));
});

afterAll(() => {
  notifyManager.setNotifyFunction((callback) => callback());
});

function installShell() {
  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    value: {
      localApps: {
        supported: true,
        list,
        status,
        start,
        stop,
        logs,
        attestedTarget,
      },
    },
  });
}

function renderView(nextTarget = target, count = 1) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient!}>
        {Array.from({ length: count }, (_, index) => (
          <LocalAppPanelView
            key={index}
            active={index === 0}
            target={{ ...nextTarget, viewInstanceId: `view-${index}` }}
          />
        ))}
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  list.mockReset().mockResolvedValue([definition]);
  status.mockReset().mockResolvedValue({ status: "stopped", generation: null } satisfies DesktopLocalAppRuntimeView);
  start.mockReset().mockResolvedValue({ status: "running", generation: "generation-a" } satisfies DesktopLocalAppRuntimeView);
  stop.mockReset().mockResolvedValue({ status: "stopped", generation: null } satisfies DesktopLocalAppRuntimeView);
  logs.mockReset().mockResolvedValue(["ready on loopback"]);
  attestedTarget.mockReset().mockResolvedValue({
    origin: "http://127.0.0.1:43123",
    openPath: "/outreach",
    partition: "persist:rudder-local-app-a",
  });
  installShell();
});

afterEach(() => {
  act(() => root?.unmount());
  queryClient?.clear();
  root = null;
  queryClient = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
  Reflect.deleteProperty(window, "desktopShell");
});

describe("LocalAppPanelView", () => {
  it("hydrates definition and status without auto-starting a stopped app", async () => {
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-start"]')).not.toBeNull());

    expect(list).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith("definition-a");
    expect(start).not.toHaveBeenCalled();
    expect(attestedTarget).not.toHaveBeenCalled();
    expect(host?.textContent).toContain("Stopped");
  });

  it("starts only after Start & open and uses the exact attested target and isolated partition", async () => {
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-start"]')).not.toBeNull());
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="local-app-start"]')?.click();
      await settle();
    });
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-webview"]')).not.toBeNull());

    const webview = host!.querySelector('[data-testid="local-app-webview"]')!;
    expect(start).toHaveBeenCalledTimes(1);
    expect(attestedTarget).toHaveBeenCalledWith("definition-a");
    expect(webview.getAttribute("src")).toBe("http://127.0.0.1:43123/outreach");
    expect(webview.getAttribute("partition")).toBe("persist:rudder-local-app-a");
    expect(webview.getAttribute("data-local-binding-id")).toBe("binding-a");
    expect(webview.getAttribute("data-view-instance-id")).toBe("view-0");
    expect(webview.hasAttribute("allowpopups")).toBe(false);
  });

  it("shares runtime state for two view instances while keeping two guest views", async () => {
    renderView(target, 2);
    await vi.waitFor(() => expect(host?.querySelectorAll('[data-testid="local-app-start"]')).toHaveLength(2));
    expect(status).toHaveBeenCalledTimes(1);

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="local-app-start"]')?.click();
      await settle();
    });
    await vi.waitFor(() => expect(host?.querySelectorAll('[data-testid="local-app-webview"]')).toHaveLength(2));
    expect(start).toHaveBeenCalledTimes(1);
    expect(new Set(Array.from(host!.querySelectorAll('[data-testid="local-app-webview"]'))
      .map((node) => node.getAttribute("data-view-instance-id")))).toEqual(new Set(["view-0", "view-1"]));
  });

  it("detects an unexpected process exit while running and discards the attested guest", async () => {
    vi.useFakeTimers();
    let runtime: DesktopLocalAppRuntimeView = { status: "running", generation: "generation-a" };
    status.mockImplementation(async () => runtime);
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-webview"]')).not.toBeNull());
    expect(status).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(status).toHaveBeenCalledTimes(4);
    expect(host?.querySelector('[data-testid="local-app-webview"]')).not.toBeNull();

    runtime = { status: "failed", generation: null, error: "Process exited unexpectedly" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(status).toHaveBeenCalledTimes(5);
    expect(host?.textContent).toContain("Failed");
    expect(host?.textContent).toContain("Process exited unexpectedly");
    expect(host?.querySelector('[data-testid="local-app-start"]')?.textContent).toContain("Retry & open");
    expect(host?.querySelector('[data-testid="local-app-webview"]')).toBeNull();
    expect(queryClient?.getQueriesData({
      queryKey: [...queryKeys.localApps.status(target.localBindingId), "attested"],
    }).some(([, data]) => Boolean(data))).toBe(false);
  });

  it("requires all three opaque identity fields and never probes a mismatched local binding", async () => {
    renderView({ ...target, desktopInstallationId: "installation-b" });
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-error"]')?.textContent).toContain("not available"));

    expect(status).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-testid="local-app-start"]')).toBeNull();
  });

  it("rejects an invalid attested target instead of creating a guest", async () => {
    status.mockResolvedValue({ status: "running", generation: "generation-a" });
    attestedTarget.mockResolvedValue({
      origin: "http://localhost:43123",
      openPath: "/outreach",
      partition: "persist:rudder-local-app-a",
    });
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-error"]')?.textContent).toContain("attested loopback"));
    expect(host?.querySelector('[data-testid="local-app-webview"]')).toBeNull();
  });

  it("shows safe logs and requires an explicit retry after start fails", async () => {
    start.mockRejectedValueOnce(new Error("Readiness timed out"))
      .mockResolvedValueOnce({ status: "running", generation: "generation-b" });
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-start"]')).not.toBeNull());
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="local-app-start"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-error"]')?.textContent).toContain("Readiness timed out"));
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-logs"]')?.textContent).toContain("ready on loopback"));
    expect(start).toHaveBeenCalledTimes(1);

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="local-app-start"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-webview"]')).not.toBeNull());
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("announces a logs failure and retries without claiming there are no logs", async () => {
    logs.mockRejectedValueOnce(new Error("Logs bridge unavailable"))
      .mockResolvedValueOnce(["recovered view log"]);
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-start"]')).not.toBeNull());
    await act(async () => {
      Array.from(host!.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Show logs")?.click();
      await vi.waitFor(() => expect(host?.querySelector('[role="alert"]')?.textContent ?? "").toContain("Logs bridge unavailable"));
    });

    expect(host?.textContent).not.toContain("No runtime logs yet.");
    const retryLogs = Array.from(host!.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Retry logs");
    expect(retryLogs).toBeDefined();
    await act(async () => {
      retryLogs?.click();
      await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-logs"]')?.textContent).toContain("recovered view log"));
    });
    expect(logs).toHaveBeenCalledTimes(2);
  });
});

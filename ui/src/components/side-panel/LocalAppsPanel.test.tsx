// @vitest-environment jsdom

import type {
  DesktopLocalAppDefinition,
  DesktopLocalAppRuntimeView,
  DesktopPreparedLocalAppDefinition,
} from "@/lib/desktop-shell";
import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAppsPanel } from "./LocalAppsPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const discovered: DesktopPreparedLocalAppDefinition = {
  title: "MKT dashboard",
  executable: "/opt/homebrew/bin/npm",
  argv: ["run", "dev"],
  cwd: "/Users/zeeland/projects/uranus/rudder/mkt/dashboard",
  inheritedEnvNames: ["RUDDER_GROWTH_DB_PATH", "RUDDER_MAIL_DB_PATH"],
  readiness: { path: "/api/health", timeoutMs: 30_000 },
  openPath: "/outreach",
  trustFingerprint: "fingerprint-a",
};

const definition: DesktopLocalAppDefinition = {
  ...discovered,
  id: "definition-a",
  desktopInstallationId: "installation-a",
  appPublicId: "public-a",
  localBindingId: "binding/a",
  approvedFingerprint: "fingerprint-a",
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

const list = vi.fn();
const discover = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const status = vi.fn();
const stop = vi.fn();
const logs = vi.fn();

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;
let opened: SidePanelTarget[] = [];

beforeAll(() => {
  notifyManager.setNotifyFunction((callback) => act(callback));
});

afterAll(() => {
  notifyManager.setNotifyFunction((callback) => callback());
});

function renderPanel(seedStatus?: DesktopLocalAppRuntimeView) {
  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    value: {
      localApps: {
        supported: true,
        list,
        discover,
        create,
        update,
        delete: remove,
        status,
        stop,
        logs,
      },
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (seedStatus) queryClient.setQueryData(queryKeys.localApps.status(definition.localBindingId), seedStatus);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <LocalAppsPanel onOpenTarget={(target) => opened.push(target)} />
      </QueryClientProvider>,
    );
  });
}

function buttonByText(text: string) {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === text) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  opened = [];
  list.mockReset().mockResolvedValue([definition]);
  discover.mockReset().mockResolvedValue({ canceled: false, draft: discovered });
  create.mockReset().mockResolvedValue(definition);
  update.mockReset().mockResolvedValue(definition);
  remove.mockReset().mockResolvedValue(undefined);
  status.mockReset().mockResolvedValue({ status: "stopped", generation: null });
  stop.mockReset().mockResolvedValue({ status: "stopped", generation: null });
  logs.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  act(() => root?.unmount());
  queryClient?.clear();
  root = null;
  queryClient = null;
  host?.remove();
  host = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "desktopShell");
});

describe("LocalAppsPanel", () => {
  it("opens a catalog definition with only its opaque identity", async () => {
    renderPanel();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="local-apps-open-binding-a"]')).not.toBeNull());
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="local-apps-open-binding-a"]')?.click());

    expect(opened).toEqual([{
      kind: "local_app",
      desktopInstallationId: "installation-a",
      appPublicId: "public-a",
      localBindingId: "binding/a",
      label: "MKT dashboard",
    }]);
    const openButton = document.querySelector<HTMLButtonElement>('[data-testid="local-apps-open-binding-a"]');
    expect(openButton?.querySelector(".lucide-app-window")).not.toBeNull();
    expect(openButton?.querySelector(".lucide-play")).toBeNull();
  });

  it("reviews a discovered definition before asking Desktop to add it", async () => {
    list.mockResolvedValue([]);
    renderPanel();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="local-apps-add"]')).not.toBeNull());
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="local-apps-add"]')?.click();
      await vi.waitFor(() => expect(document.querySelector('[data-testid="local-app-definition-review"]')).not.toBeNull());
    });

    expect(create).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("#local-app-cwd")?.value).toBe(discovered.cwd);
    expect(document.body.textContent).toContain("can modify local files and data");
    await act(async () => {
      buttonByText("Review & add")?.click();
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    });
    expect(create).toHaveBeenCalledWith({
      title: discovered.title,
      executable: discovered.executable,
      argv: discovered.argv,
      cwd: discovered.cwd,
      inheritedEnvNames: discovered.inheritedEnvNames,
      readiness: discovered.readiness,
      openPath: discovered.openPath,
    });
  });

  it("supports cancellation and exposes discovery failures without persisting anything", async () => {
    list.mockResolvedValue([]);
    discover.mockResolvedValueOnce({ canceled: true }).mockRejectedValueOnce(new Error("Unsupported project"));
    renderPanel();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="local-apps-add"]')).not.toBeNull());
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="local-apps-add"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[data-testid="local-app-definition-review"]')).toBeNull();
    expect(create).not.toHaveBeenCalled();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="local-apps-add"]')?.click();
      await vi.waitFor(() => expect(document.querySelector('[data-testid="local-app-error"]')?.textContent).toContain("Unsupported project"));
    });
    expect(buttonByText("Retry")?.disabled).toBe(false);
  });

  it("guards edit and delete while active and offers an explicit Stop", async () => {
    status.mockResolvedValue({ status: "running", generation: "generation-a" });
    renderPanel();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="local-apps-app-binding-a"]')).not.toBeNull());

    expect(buttonByText("Edit")?.disabled).toBe(true);
    expect(buttonByText("Delete")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Stop this Local App before editing or deleting it.");
    await act(async () => {
      buttonByText("Stop")?.click();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledWith("definition-a"));
    });
  });

  it("keeps checking a running definition and unlocks its controls after an external failure", async () => {
    vi.useFakeTimers();
    let runtime: DesktopLocalAppRuntimeView = { status: "running", generation: "generation-a" };
    status.mockImplementation(async () => runtime);
    renderPanel();
    const card = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLElement>('[data-testid="local-apps-app-binding-a"]');
      expect(candidate?.textContent).toContain("running");
      return candidate!;
    });
    expect(status).toHaveBeenCalledTimes(1);

    runtime = { status: "failed", generation: null, error: "Process exited unexpectedly" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(status).toHaveBeenCalledTimes(2);
    expect(card.textContent).toContain("failed");
    expect(Array.from(card.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Stop")).toBeUndefined();
    expect(Array.from(card.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Edit")?.disabled).toBe(false);
    expect(Array.from(card.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Delete")?.disabled).toBe(false);
  });

  it("offers Retry for a catalog load failure", async () => {
    list.mockRejectedValueOnce(new Error("Registry unavailable")).mockResolvedValueOnce([]);
    renderPanel();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="local-app-error"]')?.textContent).toContain("Registry unavailable"));
    await act(async () => {
      buttonByText("Retry")?.click();
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    });
  });

  it("announces delete failures and exposes logs as a focusable region", async () => {
    remove.mockRejectedValue(new Error("Delete blocked"));
    renderPanel();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="local-apps-app-binding-a"]')).not.toBeNull());
    await act(async () => {
      buttonByText("Logs")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const logRegion = document.querySelector('[data-testid="local-app-logs"]');
    expect(logRegion?.getAttribute("tabindex")).toBe("0");
    expect(logRegion?.getAttribute("aria-label")).toContain("MKT dashboard");

    act(() => buttonByText("Delete")?.click());
    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    const confirmDelete = Array.from(dialog?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.trim() === "Delete");
    await act(async () => {
      confirmDelete?.click();
      await vi.waitFor(() => expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain("Delete blocked"));
    });
    act(() => buttonByText("Cancel")?.click());
    expect(document.querySelector('[data-testid="local-app-error"]')).toBeNull();
  });

  it("locks edit and delete while status is unavailable and retries status explicitly", async () => {
    status.mockRejectedValueOnce(new Error("Status bridge unavailable"))
      .mockResolvedValueOnce({ status: "stopped", generation: null });
    renderPanel({ status: "stopped", generation: null });
    const card = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLElement>('[data-testid="local-apps-app-binding-a"]');
      expect(candidate?.querySelector('[role="alert"]')?.textContent ?? "").toContain("Status bridge unavailable");
      return candidate!;
    });

    expect(Array.from(card.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Edit")?.disabled).toBe(true);
    expect(Array.from(card.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Delete")?.disabled).toBe(true);
    const retryStatus = Array.from(card.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Retry status");
    expect(retryStatus).toBeDefined();
    await act(async () => {
      retryStatus?.click();
      await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    });
    await vi.waitFor(() => expect(
      Array.from(card.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Edit")?.disabled,
    ).toBe(false));
  });

  it("announces a stop failure and provides an explicit stop retry", async () => {
    status.mockResolvedValue({ status: "running", generation: "generation-a" });
    stop.mockRejectedValueOnce(new Error("Stop bridge unavailable"))
      .mockResolvedValueOnce({ status: "stopped", generation: null });
    renderPanel();
    const card = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLElement>('[data-testid="local-apps-app-binding-a"]');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    await act(async () => {
      Array.from(card.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Stop")?.click();
      await vi.waitFor(() => expect(card.querySelector('[role="alert"]')?.textContent ?? "").toContain("Stop bridge unavailable"));
    });

    const retryStop = Array.from(card.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Retry stop");
    expect(retryStop).toBeDefined();
    await act(async () => {
      retryStop?.click();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
    });
  });

  it("announces a logs failure and retries without claiming there are no logs", async () => {
    logs.mockRejectedValueOnce(new Error("Logs bridge unavailable"))
      .mockResolvedValueOnce(["recovered log"]);
    renderPanel();
    const card = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLElement>('[data-testid="local-apps-app-binding-a"]');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    await act(async () => {
      Array.from(card.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Logs")?.click();
      await vi.waitFor(() => expect(card.querySelector('[role="alert"]')?.textContent ?? "").toContain("Logs bridge unavailable"));
    });

    expect(card.textContent).not.toContain("No runtime logs yet.");
    const retryLogs = Array.from(card.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Retry logs");
    expect(retryLogs).toBeDefined();
    await act(async () => {
      retryLogs?.click();
      await vi.waitFor(() => expect(card.querySelector('[data-testid="local-app-logs"]')?.textContent).toContain("recovered log"));
    });
    expect(logs).toHaveBeenCalledTimes(2);
  });
});

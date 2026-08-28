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

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: "org-a" }),
}));

const messengerMocks = vi.hoisted(() => ({
  getSavedView: vi.fn(),
  keepSavedView: vi.fn(),
  updateSavedView: vi.fn(),
}));

vi.mock("@/api/messenger", () => ({
  messengerApi: messengerMocks,
}));

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

const pinnedSavedView = {
  id: "saved-view-a",
  orgId: "org-a",
  userId: "user-a",
  targetKind: "local_app",
  targetPayload: {
    kind: "local_app",
    desktopInstallationId: "installation-a",
    appPublicId: "public-a",
    localBindingId: "binding-a",
    viewInstanceId: "view-0",
  },
  title: "Marketing dashboard",
  subtitle: "Local app",
  favicon: null,
  sortOrder: 0,
  hiddenAt: null,
  primaryRailPinnedAt: new Date("2026-08-28T00:00:00.000Z"),
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

const list = vi.fn();
const status = vi.fn();
const start = vi.fn();
const stop = vi.fn();
const update = vi.fn();
const logs = vi.fn();
const attestedTarget = vi.fn();
const navigate = vi.fn();

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
}));

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
        update,
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

function openMoreMenu() {
  const trigger = host?.querySelector<HTMLButtonElement>('[data-testid="local-app-more"]');
  trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  trigger?.click();
}

beforeEach(() => {
  messengerMocks.getSavedView.mockReset().mockResolvedValue(pinnedSavedView);
  messengerMocks.keepSavedView.mockReset().mockResolvedValue({ savedView: pinnedSavedView, group: null });
  messengerMocks.updateSavedView.mockReset().mockResolvedValue(pinnedSavedView);
  list.mockReset().mockResolvedValue([definition]);
  status.mockReset().mockResolvedValue({ status: "stopped", generation: null } satisfies DesktopLocalAppRuntimeView);
  start.mockReset().mockResolvedValue({ status: "running", generation: "generation-a" } satisfies DesktopLocalAppRuntimeView);
  stop.mockReset().mockResolvedValue({ status: "stopped", generation: null } satisfies DesktopLocalAppRuntimeView);
  update.mockReset().mockResolvedValue(definition);
  logs.mockReset().mockResolvedValue(["ready on loopback"]);
  attestedTarget.mockReset().mockResolvedValue({
    origin: "http://127.0.0.1:43123",
    openPath: "/outreach",
    partition: "persist:rudder-local-app-a",
  });
  navigate.mockReset();
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
  it("keeps and pins an unsaved Local App in one enabled action", async () => {
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-start"]')).not.toBeNull());

    await act(async () => {
      openMoreMenu();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Pin to Primary Rail"));
    });
    const pinItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.includes("Pin to Primary Rail"));
    expect(pinItem?.hasAttribute("aria-disabled")).toBe(false);

    await act(async () => {
      pinItem?.click();
      await settle();
    });
    await vi.waitFor(() => expect(messengerMocks.keepSavedView).toHaveBeenCalledTimes(1));
    expect(messengerMocks.keepSavedView).toHaveBeenCalledWith("org-a", expect.objectContaining({
      clientMutationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      placement: { kind: "loose" },
      primaryRailPinned: true,
      target: expect.objectContaining({
        kind: "local_app",
        localBindingId: "binding-a",
        viewInstanceId: "view-0",
      }),
    }));
    expect(messengerMocks.updateSavedView).not.toHaveBeenCalled();

    await act(async () => {
      openMoreMenu();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Unpin from Primary Rail"));
    });
  });

  it("retries a committed keep with the exact original request after a lost response", async () => {
    messengerMocks.keepSavedView
      .mockRejectedValueOnce(new Error("Response lost after commit"))
      .mockResolvedValueOnce({ savedView: pinnedSavedView, group: null });
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-start"]')).not.toBeNull());

    await act(async () => {
      openMoreMenu();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Pin to Primary Rail"));
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent?.includes("Pin to Primary Rail"))?.click();
      await settle();
    });
    await vi.waitFor(() => expect(messengerMocks.keepSavedView).toHaveBeenCalledTimes(1));

    act(() => {
      root!.render(
        <QueryClientProvider client={queryClient!}>
          <LocalAppPanelView
            key={0}
            active
            target={{ ...target, label: "Renamed after uncertain commit", viewInstanceId: "view-0" }}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      openMoreMenu();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Pin to Primary Rail"));
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent?.includes("Pin to Primary Rail"))?.click();
      await settle();
    });
    await vi.waitFor(() => expect(messengerMocks.keepSavedView).toHaveBeenCalledTimes(2));
    expect(messengerMocks.keepSavedView.mock.calls[1]).toEqual(messengerMocks.keepSavedView.mock.calls[0]);
    expect(messengerMocks.keepSavedView.mock.calls[1]?.[1]).toMatchObject({
      title: "Marketing dashboard",
    });
  });

  it("hydrates definition and status without auto-starting a stopped app", async () => {
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-start"]')).not.toBeNull());

    expect(list).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith("definition-a");
    expect(start).not.toHaveBeenCalled();
    expect(attestedTarget).not.toHaveBeenCalled();
    expect(host?.textContent).toContain("Stopped");
    expect(host?.querySelector('[data-testid="local-app-ask-ai"]')).toBeNull();
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
    expect(host?.querySelector('[data-testid="local-app-ask-ai"]')).not.toBeNull();
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
    const rawFailure = "Readiness timed out at /Users/private/marketing while using API_KEY=not-for-chat";
    start.mockRejectedValueOnce(new Error(rawFailure))
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

    const callsBeforeHelp = { logs: logs.mock.calls.length, start: start.mock.calls.length };
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="local-app-ask-ai"]')?.click();
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    const helpUrl = new URL(String(navigate.mock.calls[0]?.[0]), "https://rudder.test");
    const prompt = helpUrl.searchParams.get("prefill") ?? "";
    expect(helpUrl.pathname).toBe("/messenger/chat");
    expect(helpUrl.searchParams.get("localAppRecoveryDraft")).toMatch(/^[0-9a-f-]{36}$/i);
    expect(prompt).toContain("Marketing dashboard");
    expect(prompt).not.toContain(rawFailure);
    expect(prompt).not.toContain(definition.cwd);
    expect(prompt).not.toContain(definition.executable);
    expect(prompt).not.toContain(definition.inheritedEnvNames[0]);
    expect(logs).toHaveBeenCalledTimes(callsBeforeHelp.logs);
    expect(start).toHaveBeenCalledTimes(callsBeforeHelp.start);

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
      openMoreMenu();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Show logs"));
      Array.from(document.querySelectorAll<HTMLDivElement>('[role="menuitem"]'))
        .find((item) => item.textContent?.includes("Show logs"))?.click();
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

  it("keeps Stop inside the More menu", async () => {
    status.mockResolvedValue({ status: "running", generation: "generation-a" });
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-webview"]')).not.toBeNull());

    expect(host?.querySelector('[data-testid="local-app-stop"]')).toBeNull();
    await act(async () => {
      openMoreMenu();
      await vi.waitFor(() => expect(document.querySelector('[data-testid="local-app-stop"]')).not.toBeNull());
      document.querySelector<HTMLElement>('[data-testid="local-app-stop"]')?.click();
      await settle();
    });
    expect(stop).toHaveBeenCalledWith("definition-a");
  });

  it("opens Edit details while running and requires Stop & edit before fields unlock", async () => {
    status.mockResolvedValue({ status: "running", generation: "generation-a" });
    renderView();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="local-app-webview"]')).not.toBeNull());

    await act(async () => {
      openMoreMenu();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Edit details"));
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent?.includes("Edit details"))?.click();
    });
    const dialog = document.querySelector<HTMLElement>('[data-testid="local-app-definition-review"]');
    act(() => dialog?.querySelector<HTMLButtonElement>('[data-testid="local-app-advanced-toggle"]')?.click());
    expect(dialog?.querySelector<HTMLInputElement>("#local-app-name")?.disabled).toBe(true);
    const stopAndEdit = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent?.includes("Stop & edit"));
    await act(async () => {
      stopAndEdit?.click();
      await settle();
    });
    await vi.waitFor(() => expect(
      document.querySelector<HTMLInputElement>("#local-app-name")?.disabled,
    ).toBe(false));
    expect(stop).toHaveBeenCalledWith("definition-a");
  });
});

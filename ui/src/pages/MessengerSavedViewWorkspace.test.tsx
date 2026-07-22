// @vitest-environment jsdom

import { SidePanelProvider, useSidePanel } from "@/context/SidePanelContext";
import type { DesktopLocalAppDefinition } from "@/lib/desktop-shell";
import type { MessengerSavedView } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessengerSavedViewWorkspace } from "./MessengerSavedViewWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getSavedView = vi.hoisted(() => vi.fn());
vi.mock("@/api/messenger", () => ({ messengerApi: { getSavedView } }));

const definition: DesktopLocalAppDefinition = {
  id: "definition-a",
  desktopInstallationId: "installation-a",
  appPublicId: "public-a",
  localBindingId: "binding-a",
  title: "MKT dashboard",
  executable: "/opt/homebrew/bin/npm",
  argv: ["run", "dev"],
  cwd: "/Users/zeeland/projects/uranus/rudder/mkt/dashboard",
  inheritedEnvNames: [],
  readiness: { path: "/api/health", timeoutMs: 30_000 },
  openPath: "/outreach",
  trustFingerprint: "fingerprint-a",
  approvedFingerprint: "fingerprint-a",
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

const savedView: MessengerSavedView = {
  id: "saved-a",
  orgId: "org-a",
  userId: "user-a",
  targetKind: "local_app",
  targetPayload: {
    kind: "local_app",
    desktopInstallationId: "installation-a",
    appPublicId: "public-a",
    localBindingId: "binding-a",
    viewInstanceId: "view-a",
  },
  resourceKey: "local-app",
  instanceId: "view-a",
  canonicalResourceKey: "local-app",
  clientMutationId: null,
  title: "MKT dashboard",
  subtitle: "Local app",
  favicon: null,
  sortOrder: 0,
  hiddenAt: null,
  createdAt: new Date("2026-07-23T00:00:00.000Z"),
  updatedAt: new Date("2026-07-23T00:00:00.000Z"),
};

const list = vi.fn();
const status = vi.fn();
const start = vi.fn();
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let client: QueryClient | null = null;

function Probe() {
  const sidePanel = useSidePanel();
  return <output data-testid="target">{JSON.stringify(sidePanel.tabs[0] ?? null)}</output>;
}

function renderWorkspace() {
  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    value: { localApps: { supported: true, list, status, start } },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <SidePanelProvider>
          <MessengerSavedViewWorkspace organizationId="org-a" savedViewId="saved-a" />
          <Probe />
        </SidePanelProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  getSavedView.mockReset().mockResolvedValue(savedView);
  list.mockReset().mockResolvedValue([definition]);
  status.mockReset().mockResolvedValue({ status: "stopped", generation: null });
  start.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  client?.clear();
  root = null;
  client = null;
  host?.remove();
  host = null;
  Reflect.deleteProperty(window, "desktopShell");
});

describe("MessengerSavedViewWorkspace Local Apps", () => {
  it("matches all opaque fields and checks status without auto-starting before opening", async () => {
    renderWorkspace();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="target"]')?.textContent).toContain('"kind":"local_app"'));

    expect(list).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith("definition-a");
    expect(start).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-testid="target"]')?.textContent).toContain('"viewInstanceId":"view-a"');
  });

  it("keeps another installation unavailable without probing or starting its binding", async () => {
    getSavedView.mockResolvedValue({
      ...savedView,
      targetPayload: { ...savedView.targetPayload, desktopInstallationId: "installation-other" },
    });
    renderWorkspace();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="messenger-saved-view-unavailable"]')).not.toBeNull());

    expect(status).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-testid="target"]')?.textContent).toBe("null");
  });

  it("shows a retryable local status failure and opens after retry succeeds", async () => {
    status.mockRejectedValueOnce(new Error("Desktop bridge unavailable"))
      .mockResolvedValueOnce({ status: "stopped", generation: null });
    renderWorkspace();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="messenger-saved-view-error"]')?.textContent).toContain("Desktop bridge unavailable"));
    expect(start).not.toHaveBeenCalled();

    await act(async () => {
      Array.from(host!.querySelectorAll("button")).find((button) => button.textContent?.includes("Retry"))?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="target"]')?.textContent).toContain('"kind":"local_app"'));
    expect(status).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import type { AppBuilderApp, Organization } from "@rudderhq/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppBuilderAutoLaunchCoordinator } from "./AppBuilderAutoLaunchCoordinator";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  apps: [] as AppBuilderApp[],
  organizations: [] as Organization[],
  selectedOrganizationId: "org-1" as string | null,
  launch: vi.fn(),
  navigate: vi.fn(),
  pushToast: vi.fn(),
  setSelectedOrganizationId: vi.fn(),
  requestAppDirectOpen: vi.fn(),
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({
    organizations: state.organizations,
    selectedOrganizationId: state.selectedOrganizationId,
    setSelectedOrganizationId: state.setSelectedOrganizationId,
  }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: state.pushToast }),
}));
vi.mock("@/lib/router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@/lib/apps-workspace", () => ({
  appRoute: (key: string) => `/apps/view/${encodeURIComponent(key)}`,
  requestAppDirectOpen: state.requestAppDirectOpen,
}));
vi.mock("@/lib/app-builder-launch", () => ({ launchManagedApp: state.launch }));
vi.mock("@/lib/desktop-shell", () => ({
  readDesktopShell: () => ({
    appBuilder: { supported: true },
    localApps: { supported: true },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
  useQuery: (options: { queryKey: readonly string[] }) => options.queryKey[0] === "health"
    ? { data: { features: { experimentalSitesEnabled: true } } }
    : { data: state.apps },
}));

function app(id: string, orgId = "org-1"): AppBuilderApp {
  return {
    id,
    orgId,
    projectId: null,
    conversationId: null,
    name: `App ${id}`,
    sourceRoot: `apps/${id}`,
    scaffoldVersion: "1",
    buildStatus: "verified_source_ready",
    latestBuildRunId: null,
    latestVerificationRunId: null,
    desktopInstallationId: null,
    appPublicId: null,
    localBindingId: null,
    createdAt: new Date("2026-08-09T00:00:00.000Z"),
    updatedAt: new Date("2026-08-09T00:00:00.000Z"),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderCoordinator() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await rerenderCoordinator();
}

async function rerenderCoordinator() {
  await act(async () => {
    root!.render(<AppBuilderAutoLaunchCoordinator />);
    await Promise.resolve();
  });
}

describe("AppBuilderAutoLaunchCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.selectedOrganizationId = "org-1";
    state.organizations = [{ id: "org-1", issuePrefix: "APP" } as Organization];
    state.apps = [];
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("serializes automatic launches", async () => {
    const first = deferred<Record<string, string>>();
    const second = deferred<Record<string, string>>();
    state.apps = [app("one"), app("two")];
    state.launch
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    await renderCoordinator();

    expect(state.launch).toHaveBeenCalledTimes(1);
    await rerenderCoordinator();
    expect(state.launch).toHaveBeenCalledTimes(1);

    state.apps[0] = { ...state.apps[0]!, buildStatus: "ready" };
    await act(async () => first.resolve({ definitionId: "one" }));
    expect(state.launch).toHaveBeenCalledTimes(2);
    state.apps[1] = { ...state.apps[1]!, buildStatus: "ready" };
    await act(async () => second.resolve({ definitionId: "two" }));
  });

  it("does not hijack navigation after an organization switch", async () => {
    const launch = deferred<Record<string, string>>();
    state.apps = [app("one")];
    state.launch.mockImplementationOnce(() => launch.promise);
    await renderCoordinator();
    expect(state.launch).toHaveBeenCalledTimes(1);

    state.selectedOrganizationId = "org-2";
    state.apps[0] = { ...state.apps[0]!, buildStatus: "ready" };
    await rerenderCoordinator();
    await act(async () => launch.resolve({ definitionId: "one" }));

    expect(state.navigate).not.toHaveBeenCalled();
    const toast = state.pushToast.mock.calls.at(-1)?.[0] as {
      body: string;
      action: { onClick: () => void };
    };
    expect(toast.body).toBe("The App finished while you were working elsewhere.");
    act(() => toast.action.onClick());
    expect(state.navigate).toHaveBeenCalledWith("/APP/apps/view/managed%3Aone");
    expect(state.setSelectedOrganizationId).toHaveBeenCalledWith("org-1", { source: "route_sync" });
    expect(state.navigate.mock.invocationCallOrder[0])
      .toBeLessThan(state.setSelectedOrganizationId.mock.invocationCallOrder[0]!);
  });
});

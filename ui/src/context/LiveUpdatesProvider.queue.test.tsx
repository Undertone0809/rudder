// @vitest-environment jsdom

import type { ChatQueueSnapshot } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { shouldPollChatQueue } from "../pages/Chat.workspace-helpers";
import { LiveUpdatesProvider } from "./LiveUpdatesProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const coordinator = vi.hoisted(() => ({ publishLiveEvent: vi.fn() }));
vi.mock("./OrganizationContext", () => ({ useOrganization: () => ({ selectedOrganizationId: "org-1" }) }));
vi.mock("./ActivityCoordinatorContext", () => ({ useActivityCoordinator: () => coordinator }));
vi.mock("./ToastContext", () => ({ useToast: () => ({ pushToast: () => null }) }));
vi.mock("../lib/router", () => ({ useLocation: () => ({ pathname: "/ORG/chat/chat-1" }) }));
vi.mock("@/hooks/useOperatorDisplayName", () => ({ useOperatorDisplayName: () => "Operator" }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-1" } }) } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getNotifications: async () => ({}) } }));

class SocketFixture {
  static instances: SocketFixture[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    SocketFixture.instances.push(this);
  }
  close() { this.onclose?.(); }
  emit(orgId: string, action = "chat.queue.created", entityId = "chat-1") {
    this.onmessage?.({ data: JSON.stringify({
      type: "activity.logged",
      orgId,
      payload: { entityType: "chat", entityId, action, actorId: "user-1" },
    }) });
  }
}

const idle: ChatQueueSnapshot = {
  activeGenerationId: null,
  activeGenerationStatus: null,
  activeAttemptEpoch: null,
  activeControlVersion: null,
  items: [],
};
const active: ChatQueueSnapshot = {
  ...idle,
  activeGenerationId: "generation-1",
  activeGenerationStatus: "running",
};

let snapshot: ChatQueueSnapshot;
const fetchQueue = vi.fn(async () => snapshot);
function QueueProbe() {
  const query = useQuery({
    queryKey: queryKeys.chats.queue("org-1", "chat-1"),
    queryFn: fetchQueue,
    refetchInterval: (state) => shouldPollChatQueue(state.state.data) ? 2_000 : false,
  });
  return <output>{query.data?.activeGenerationId ?? "idle"}</output>;
}

let branding = "#111111";
let goalId = "goal-old";
const fetchOrganizations = vi.fn(async () => [{ id: "org-1", brandColor: branding }]);
const fetchProject = vi.fn(async () => ({ id: "project-1", orgId: "org-1", goalIds: [goalId] }));
const mountedProjectKey = [...queryKeys.projects.detail("project-1"), "org-1"];
function PersistedModelsProbe() {
  const organizations = useQuery({ queryKey: queryKeys.organizations.all, queryFn: fetchOrganizations });
  const project = useQuery({ queryKey: mountedProjectKey, queryFn: fetchProject });
  return <output data-testid="persisted-models">{organizations.data?.[0].brandColor}:{project.data?.goalIds.join(",")}</output>;
}

let client: QueryClient;
let root: Root;
let container: HTMLDivElement;
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function mount(includePersistedModels = false) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <LiveUpdatesProvider><QueueProbe />{includePersistedModels && <PersistedModelsProbe />}</LiveUpdatesProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { SocketFixture.instances[0].onopen?.(); });
  await advance(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", SocketFixture);
  SocketFixture.instances = [];
  snapshot = idle;
  fetchQueue.mockClear();
  branding = "#111111";
  goalId = "goal-old";
  fetchOrganizations.mockClear();
  fetchProject.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.chats.queue("org-1", "chat-1"), idle);
  client.setQueryData(queryKeys.chats.queue("org-1", "chat-2"), idle);
  client.setQueryData(queryKeys.chats.queue("org-2", "chat-1"), idle);
  client.setQueryData(queryKeys.chats.detail("org-1", "chat-1"), { id: "chat-1" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LiveUpdatesProvider idle queue recovery", () => {
  it("reconciles missed branding and goal-link hints on reconnect without refreshing another organization", async () => {
    const readModelKeys = [queryKeys.activityRoot, queryKeys.dashboard, queryKeys.sidebarBadges];
    for (const key of readModelKeys) {
      client.setQueryData(key("org-1"), []);
      client.setQueryData(key("org-2"), []);
    }
    client.setQueryData(queryKeys.organizations.all, [{ id: "org-1", brandColor: branding }]);
    client.setQueryData(queryKeys.organizations.detail("org-1"), { id: "org-1", brandColor: branding });
    client.setQueryData(queryKeys.organizations.detail("org-2"), { id: "org-2" });
    client.setQueryData(mountedProjectKey, { id: "project-1", orgId: "org-1", goalIds: [goalId] });
    client.setQueryData(queryKeys.projects.detail("inactive-own"), { id: "inactive-own", orgId: "org-1" });
    client.setQueryData(queryKeys.projects.detail("other"), { id: "other", orgId: "org-2" });
    client.setQueryData(queryKeys.projects.list("org-1"), []);
    client.setQueryData(queryKeys.projects.list("org-2"), []);
    await mount(true);
    expect(fetchOrganizations).not.toHaveBeenCalled();
    expect(fetchProject).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="persisted-models"]')?.textContent).toBe("#111111:goal-old");
    await act(async () => { SocketFixture.instances[0].close(); });
    branding = "#abcdef";
    goalId = "goal-new";
    await advance(1_000);
    await act(async () => { SocketFixture.instances[1].onopen?.(); });
    await advance(1);
    expect(fetchOrganizations).toHaveBeenCalledTimes(1);
    expect(fetchProject).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="persisted-models"]')?.textContent).toBe("#abcdef:goal-new");
    expect(client.getQueryState(queryKeys.projects.detail("inactive-own"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.projects.list("org-1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.organizations.detail("org-1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.projects.detail("other"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(queryKeys.projects.list("org-2"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(queryKeys.organizations.detail("org-2"))?.isInvalidated).toBe(false);
    for (const key of readModelKeys) {
      expect(client.getQueryState(key("org-1"))?.isInvalidated).toBe(true);
      expect(client.getQueryState(key("org-2"))?.isInvalidated).toBe(false);
    }
  });

  it("replaces a data-less pre-disconnect project read and ignores its late stale response", async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof fetchProject>>) => void;
    fetchProject.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const otherKey = [...queryKeys.projects.detail("other"), "org-2"];
    client.setQueryData(otherKey, { orgId: "org-2", goalIds: ["other-goal"] });
    await mount(true);
    expect(fetchProject).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(mountedProjectKey)).toBeUndefined();
    await act(async () => { SocketFixture.instances[0].close(); });
    goalId = "goal-new";
    await advance(1_000);
    await act(async () => { SocketFixture.instances[1].onopen?.(); });
    await advance(1);
    expect(fetchProject).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="persisted-models"]')?.textContent).toBe("#111111:goal-new");
    await act(async () => { resolveOld({ id: "project-1", orgId: "org-1", goalIds: ["goal-old"] }); });
    await advance(1);
    expect(client.getQueryData(mountedProjectKey)).toMatchObject({ goalIds: ["goal-new"] });
    expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  it.each(["activity", "reconnect"])("wakes an idle mounted queue on %s and stops after terminal convergence", async (wake) => {
    await mount();
    fetchQueue.mockClear();
    await advance(6_000);
    expect(fetchQueue).not.toHaveBeenCalled();
    snapshot = active;
    if (wake === "activity") {
      await act(async () => { SocketFixture.instances[0].emit("org-1"); });
    } else {
      await act(async () => { SocketFixture.instances[0].close(); });
      await advance(1_000);
      expect(SocketFixture.instances).toHaveLength(2);
      expect(SocketFixture.instances[1].url).toContain("/api/orgs/org-1/events/ws");
      await act(async () => { SocketFixture.instances[1].onopen?.(); });
    }
    await advance(1);
    expect(fetchQueue).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("generation-1");
    expect(client.getQueryState(queryKeys.chats.queue("org-2", "chat-1"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(queryKeys.chats.queue("org-1", "chat-2"))?.isInvalidated).toBe(wake === "reconnect");
    await advance(2_000);
    expect(fetchQueue).toHaveBeenCalledTimes(2);
    snapshot = { ...active, activeGenerationStatus: "completed" };
    await advance(2_000);
    expect(fetchQueue).toHaveBeenCalledTimes(3);
    expect(shouldPollChatQueue(client.getQueryData(queryKeys.chats.queue("org-1", "chat-1")))).toBe(false);
    await advance(6_000);
    expect(fetchQueue).toHaveBeenCalledTimes(3);
  });

  it("ignores another organization and conversation without waking the idle queue", async () => {
    await mount();
    fetchQueue.mockClear();
    snapshot = active;
    await act(async () => {
      SocketFixture.instances[0].emit("org-2");
      SocketFixture.instances[0].emit("org-1", "chat.queue.created", "chat-2");
    });
    await advance(6_000);
    expect(fetchQueue).not.toHaveBeenCalled();
    expect(container.textContent).toBe("idle");
    expect(client.getQueryState(queryKeys.chats.queue("org-2", "chat-1"))?.isInvalidated).toBe(false);
  });
});

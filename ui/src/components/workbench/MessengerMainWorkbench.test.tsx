// @vitest-environment jsdom

import {
  createLiveSurfaceRuntimeId,
  LiveSurfaceAnchor,
  LiveSurfaceRuntimeLayer,
  LiveSurfaceRuntimeProvider,
} from "@/context/LiveSurfaceRuntimeContext";
import {
  MainWorkbenchProvider,
  useOrganizationMainWorkbench,
  type OrganizationMainWorkbench,
} from "@/context/MainWorkbenchContext";
import {
  createMainWorkbenchState,
  mainWorkbenchReducer,
  type MainWorkbenchState,
  type MainWorkbenchTabDraft,
  type MainWorkbenchTarget,
} from "@/lib/main-workbench-state";
import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import type {
  MessengerCustomGroupsResponse,
  MessengerSavedView,
} from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessengerMainWorkbench } from "./MessengerMainWorkbench";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let controls: OrganizationMainWorkbench | null = null;
let queryClient: QueryClient | null = null;
let emitDragEnd: ((event: {
  active: { id: string };
  over: { id: string } | null;
}) => void) | null = null;
let nextId = 0;

const createCustomGroup = vi.hoisted(() => vi.fn());
const keepSavedView = vi.hoisted(() => vi.fn());
const listCustomGroups = vi.hoisted(() => vi.fn());
const updateSavedView = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const pushToast = vi.hoisted(() => vi.fn());
const scrollIntoView = vi.fn();
const nativeGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

vi.mock("@/api/messenger", () => ({
  messengerApi: {
    createCustomGroup,
    keepSavedView,
    listCustomGroups,
    updateSavedView,
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@/context/ToastContext", () => ({
  useOptionalToast: () => ({ pushToast }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) => (
    open ? <div role="dialog">{children}</div> : null
  ),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@dnd-kit/core", async () => {
  const React = await import("react");
  return {
    closestCenter: vi.fn(),
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: ReactNode;
      onDragEnd: typeof emitDragEnd;
    }) => {
      emitDragEnd = onDragEnd;
      return React.createElement(React.Fragment, null, children);
    },
    KeyboardSensor: vi.fn(),
    PointerSensor: vi.fn(),
    useSensor: vi.fn((sensor, options) => ({ options, sensor })),
    useSensors: vi.fn((...sensors) => sensors),
  };
});

vi.mock("@dnd-kit/sortable", async () => {
  const React = await import("react");
  return {
    horizontalListSortingStrategy: {},
    sortableKeyboardCoordinates: vi.fn(),
    SortableContext: ({ children }: { children: ReactNode }) => (
      React.createElement(React.Fragment, null, children)
    ),
    useSortable: ({ id }: { id: string }) => ({
      attributes: {
        "aria-describedby": `sortable-${id}`,
        "aria-roledescription": "sortable tab",
      },
      isDragging: false,
      listeners: {},
      setActivatorNodeRef: vi.fn(),
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
    }),
  };
});

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

vi.mock("@/components/workbench/BrowserLiveSurface", () => ({
  BrowserLiveSurface: ({
    target,
    onCloseTarget,
    onOpenTarget,
    onReplaceTarget,
    onCycleTab,
  }: {
    target: Extract<MainWorkbenchTarget, { kind: "browser" }>;
    onCloseTarget: (target: MainWorkbenchTarget) => void;
    onOpenTarget: (target: SidePanelTarget) => void;
    onReplaceTarget: (key: string, target: MainWorkbenchTarget) => void;
    onCycleTab?: (direction: -1 | 1) => void;
  }) => (
    <div data-testid="mock-browser-live-surface" data-label={target.label}>
      <button
        type="button"
        data-testid="mock-browser-replace"
        onClick={() => onReplaceTarget("ignored", {
          ...target,
          favicon: "https://navigated.example/favicon.ico",
          label: "Navigated page",
          url: "https://navigated.example",
        })}
      >
        Replace
      </button>
      <button
        type="button"
        data-testid="mock-browser-open"
        onClick={() => onOpenTarget({
          kind: "browser",
          label: "Popup",
          tabId: "popup-tab",
          url: "https://popup.example",
          viewInstanceId: "popup-view",
        })}
      >
        Open
      </button>
      <button
        type="button"
        data-testid="mock-browser-cycle"
        onClick={() => onCycleTab?.(1)}
      >
        Cycle
      </button>
      <button
        type="button"
        data-testid="mock-open-linked-chat"
        onClick={() => onOpenTarget({
          kind: "chat",
          conversationId: "automation-linked-chat",
          label: "Automation run",
          messageId: null,
        })}
      >
        Open linked chat
      </button>
      <button
        type="button"
        data-testid="mock-browser-close"
        onClick={() => onCloseTarget(target)}
      >
        Close
      </button>
    </div>
  ),
}));

vi.mock("@/components/side-panel/LocalAppPanelView", () => ({
  LocalAppPanelView: ({ target }: { target: MainWorkbenchTarget }) => (
    <div data-testid="mock-local-app-live-surface">{target.label}</div>
  ),
}));

beforeEach(() => {
  nextId = 0;
  controls = null;
  emitDragEnd = null;
  createCustomGroup.mockReset();
  keepSavedView.mockReset();
  listCustomGroups.mockReset().mockResolvedValue({ groups: [] });
  updateSavedView.mockReset().mockResolvedValue({});
  navigate.mockReset();
  pushToast.mockReset();
  scrollIntoView.mockReset();
  window.localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.hasAttribute("data-owner-id")) {
      return {
        bottom: 800,
        height: 800,
        left: 0,
        right: 1_200,
        top: 0,
        width: 1_200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    }
    return nativeGetBoundingClientRect.call(this);
  };
});

afterEach(() => {
  act(() => root?.unmount());
  queryClient?.clear();
  host?.remove();
  root = null;
  host = null;
  queryClient = null;
  HTMLElement.prototype.getBoundingClientRect = nativeGetBoundingClientRect;
});

function target(
  kind: MainWorkbenchTarget["kind"],
  viewInstanceId: string,
): MainWorkbenchTarget {
  if (kind === "browser") {
    return {
      kind,
      label: "Browser",
      tabId: `browser-${viewInstanceId}`,
      url: "https://browser.example",
      viewInstanceId,
    };
  }
  if (kind === "local_app") {
    return {
      kind,
      appPublicId: "mkt-dashboard",
      desktopInstallationId: "desktop-a",
      label: "MKT dashboard",
      localBindingId: "binding-a",
      viewInstanceId,
    };
  }
  if (kind === "automation") {
    return {
      kind,
      automationId: "automation-a",
      label: "Daily growth",
      viewInstanceId,
    };
  }
  if (kind === "library_directory") {
    return {
      kind,
      directoryPath: "/reports",
      label: "Reports",
      viewInstanceId,
    };
  }
  if (kind === "library_document") {
    return {
      kind,
      documentId: "document-a",
      label: "Launch brief",
      viewInstanceId,
    };
  }
  if (kind === "library_entry") {
    return {
      kind,
      entryId: "entry-a",
      label: "Entry",
      path: "entry.md",
      viewInstanceId,
    };
  }
  return {
    kind: "library_file",
    filePath: "/reports/growth.md",
    label: "growth.md",
    viewInstanceId,
  };
}

function tabDraft(nextTarget: MainWorkbenchTarget): MainWorkbenchTabDraft {
  return {
    originContextKey: "main:org-a",
    runtimeId: createLiveSurfaceRuntimeId("org-a", nextTarget),
    target: nextTarget,
    viewInstanceId: nextTarget.viewInstanceId,
  };
}

function group(
  id: string,
  name: string,
): MessengerCustomGroupsResponse["groups"][number] {
  const now = new Date("2026-07-23T08:00:00.000Z");
  return {
    id,
    orgId: "org-a",
    userId: "local-board",
    name,
    icon: null,
    sortOrder: id === "group-a" ? 0 : 1,
    collapsed: false,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
    entries: [],
  };
}

function savedBrowser(
  browser: Extract<MainWorkbenchTarget, { kind: "browser" }>,
  savedViewId: string,
): MessengerSavedView {
  const now = new Date("2026-07-23T08:00:00.000Z");
  return {
    id: savedViewId,
    orgId: "org-a",
    userId: "local-board",
    targetKind: "browser",
    targetPayload: {
      kind: "browser",
      tabId: browser.tabId,
      url: browser.url,
      viewInstanceId: browser.viewInstanceId,
    },
    resourceKey: `browser:${browser.tabId}`,
    instanceId: browser.viewInstanceId,
    canonicalResourceKey: `browser:${browser.tabId}`,
    clientMutationId: "mutation-a",
    title: browser.label,
    subtitle: browser.url,
    favicon: browser.favicon ?? null,
    sortOrder: 0,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function customGroupsWithSavedBrowser(
  browser: Extract<MainWorkbenchTarget, { kind: "browser" }>,
  savedViewId: string,
): MessengerCustomGroupsResponse {
  const savedView = savedBrowser(browser, savedViewId);
  const savedGroup = group("group-a", "Research");
  return {
    groups: [{
      ...savedGroup,
      entries: [{
        id: `entry-${savedViewId}`,
        orgId: "org-a",
        userId: "local-board",
        groupId: savedGroup.id,
        itemKey: `saved-view:${savedViewId}`,
        sortOrder: 0,
        createdAt: savedView.createdAt,
        updatedAt: savedView.updatedAt,
        item: {
          type: "saved_view",
          itemKey: `saved-view:${savedViewId}`,
          title: savedView.title,
          savedView,
        },
      }],
    }],
  };
}

function detachingPromotionState(
  browser: Extract<MainWorkbenchTarget, { kind: "browser" }>,
): MainWorkbenchState {
  const runtimeId = createLiveSurfaceRuntimeId("org-a", browser);
  const source = {
    originContextKey: "chat:source",
    runtimeId,
    savedViewId: null,
    sourceRevision: 7,
    target: browser,
    viewInstanceId: browser.viewInstanceId,
  };
  let state = createMainWorkbenchState();
  state = mainWorkbenchReducer(state, {
    type: "runtime/admit",
    organizationId: "org-a",
    runtime: {
      host: { kind: "side", contextKey: source.originContextKey },
      id: runtimeId,
      target: browser,
      targetKind: "browser",
      viewInstanceId: browser.viewInstanceId,
    },
  });
  state = mainWorkbenchReducer(state, {
    type: "promotion/start",
    clientMutationId: "mutation-a",
    organizationId: "org-a",
    promotionId: "promotion-a",
    source,
  });
  state = mainWorkbenchReducer(state, {
    type: "promotion/server-commit",
    expectedSourceRevision: source.sourceRevision,
    organizationId: "org-a",
    promotionId: "promotion-a",
    savedViewId: "saved-a",
  });
  return mainWorkbenchReducer(state, {
    type: "promotion/claim",
    expectedSourceRevision: source.sourceRevision,
    organizationId: "org-a",
    promotionId: "promotion-a",
    savedViewId: "saved-a",
  });
}

function Harness() {
  controls = useOrganizationMainWorkbench("org-a");
  return <MessengerMainWorkbench organizationId="org-a" />;
}

function renderWorkbench({
  initialState,
  runtimeLayer = false,
  sideTarget,
}: {
  initialState?: MainWorkbenchState;
  runtimeLayer?: boolean;
  sideTarget?: Extract<MainWorkbenchTarget, { kind: "browser" }>;
} = {}) {
  host = document.createElement("div");
  host.style.width = "1200px";
  host.style.height = "800px";
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <MainWorkbenchProvider
          createId={() => `generated-${nextId++}`}
          initialState={initialState}
        >
          <LiveSurfaceRuntimeProvider>
            {sideTarget ? (
              <LiveSurfaceAnchor
                active
                hostId="source-side-host"
                ownerId={`side:chat:source:${createLiveSurfaceRuntimeId("org-a", sideTarget)}`}
                runtimeId={createLiveSurfaceRuntimeId("org-a", sideTarget)}
                target={sideTarget}
              />
            ) : null}
            <Harness />
            {runtimeLayer ? <LiveSurfaceRuntimeLayer /> : null}
          </LiveSurfaceRuntimeProvider>
        </MainWorkbenchProvider>
      </QueryClientProvider>,
    );
  });
}

function openKinds(kinds: MainWorkbenchTarget["kind"][]) {
  act(() => {
    kinds.forEach((kind, index) => {
      const nextTarget = target(kind, `view-${index}`);
      controls!.createSessionTab(tabDraft(nextTarget));
    });
  });
}

function tabs() {
  return Array.from(host!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
}

describe("MessengerMainWorkbench", () => {
  it("renders a transparent full-bleed workbench without nesting another Browser card", () => {
    renderWorkbench();
    openKinds(["browser", "local_app", "library_document", "automation"]);

    const workbench = host!.querySelector<HTMLElement>(
      '[data-testid="messenger-main-workbench"]',
    )!;
    expect(workbench.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(workbench.className).not.toContain("workspace-main-card");
    expect(workbench.className).not.toMatch(/\brounded/);
    expect(workbench.className).not.toMatch(/\bp-[1-9]/);
    expect(workbench.querySelector('[data-testid="browser-main-card"]')).toBeNull();
    expect(workbench.querySelector('[data-testid="messenger-main-live-surface-anchor"]'))
      .not.toBeNull();
    expect(tabs().map((tab) => tab.dataset.targetKind)).toEqual([
      "browser",
      "local_app",
      "library_document",
      "automation",
    ]);
  });

  it("keeps tab activation, manual keyboard activation, and the canonical route in sync", () => {
    renderWorkbench();
    const savedTarget = target("browser", "saved-view") as Extract<
      MainWorkbenchTarget,
      { kind: "browser" }
    >;
    const sessionTarget = target("library_file", "session-view");
    act(() => {
      controls!.openSavedTab("saved-a", tabDraft(savedTarget));
      controls!.createSessionTab(tabDraft(sessionTarget));
    });
    navigate.mockClear();

    act(() => tabs()[0]?.click());
    expect(controls!.activeViewInstanceId).toBe("saved-view");
    expect(navigate).toHaveBeenLastCalledWith(
      "/messenger/saved/saved-a",
      { replace: true },
    );

    act(() => {
      tabs()[1]?.focus();
      tabs()[1]?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Enter",
      }));
    });
    expect(controls!.activeViewInstanceId).toBe("session-view");
    expect(navigate).toHaveBeenLastCalledWith(
      "/messenger/workbench",
      { replace: true },
    );
  });

  it("reorders Main tabs without changing their durable bindings", () => {
    renderWorkbench();
    openKinds(["browser", "library_document", "automation"]);
    act(() => controls!.bindSavedView("view-0", "saved-browser"));

    act(() => emitDragEnd?.({
      active: { id: "view-0" },
      over: { id: "view-2" },
    }));

    expect(tabs().map((tab) => tab.dataset.viewInstanceId)).toEqual([
      "view-1",
      "view-2",
      "view-0",
    ]);
    expect(controls!.tabsByViewInstanceId["view-0"]?.savedViewId)
      .toBe("saved-browser");
  });

  it("creates session-only Browser tabs from + and disables creation at shared capacity", () => {
    renderWorkbench();
    const add = host!.querySelector<HTMLButtonElement>('[aria-label="New Browser tab"]')!;

    act(() => add.click());
    expect(controls!.activeTab).toMatchObject({
      savedViewId: null,
      target: { kind: "browser", url: "about:blank" },
    });
    expect(navigate).toHaveBeenLastCalledWith(
      "/messenger/workbench",
      { replace: true },
    );

    act(() => {
      for (let index = 1; index < 8; index += 1) {
        controls!.createSessionBrowser();
      }
    });
    expect(
      host!.querySelector<HTMLButtonElement>('[aria-label="New Browser tab"]')
        ?.disabled,
    ).toBe(true);
  });

  it("keeps a session Browser only after explicit confirmation with the recent group preselected", async () => {
    const groups = [group("group-a", "Research"), group("group-b", "Review")];
    listCustomGroups.mockResolvedValue({ groups });
    window.localStorage.setItem(
      "rudder.messengerRecentSavedViewGroup:org-a",
      "group-b",
    );
    renderWorkbench();
    const browser = {
      kind: "browser",
      label: "Market dashboard",
      tabId: "market-tab",
      url: "https://example.com/private/report",
      viewInstanceId: "market-view",
    } satisfies Extract<MainWorkbenchTarget, { kind: "browser" }>;
    act(() => controls!.createSessionBrowser(browser));
    await vi.waitFor(() => expect(listCustomGroups).toHaveBeenCalledWith("org-a"));

    await act(async () => {
      host!
        .querySelector<HTMLButtonElement>(
          '[aria-label="Keep active Browser in Messenger"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(
      Array.from(document.querySelectorAll('[role="radio"]'))
        .find((option) => option.textContent?.includes("Review"))
        ?.getAttribute("aria-checked"),
    ).toBe("true"));
    expect(keepSavedView).not.toHaveBeenCalled();

    keepSavedView.mockResolvedValue({
      savedView: savedBrowser(browser, "saved-market"),
      group: { id: "group-b", name: "Review" },
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="confirm-main-browser-keep"]')
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(controls!.activeTab?.savedViewId)
      .toBe("saved-market"));
    expect(keepSavedView).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({
        placement: { kind: "group", groupId: "group-b" },
      }),
    );
    expect(navigate).toHaveBeenLastCalledWith(
      "/messenger/saved/saved-market",
      { replace: true },
    );
  });

  it("creates an editable default group before keeping when Messenger has no groups", async () => {
    listCustomGroups.mockResolvedValue({ groups: [] });
    renderWorkbench();
    const browser = target("browser", "local-view") as Extract<
      MainWorkbenchTarget,
      { kind: "browser" }
    >;
    act(() => controls!.createSessionBrowser(browser));
    await vi.waitFor(() => expect(listCustomGroups).toHaveBeenCalled());
    await act(async () => {
      host!
        .querySelector<HTMLButtonElement>(
          '[aria-label="Keep active Browser in Messenger"]',
        )
        ?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(
      document.querySelector<HTMLInputElement>(
        '[aria-label="New Messenger group name"]',
      )?.value,
    ).toBe("Saved views"));
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="New Messenger group name"]',
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "Dashboard tools");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const created = group("group-created", "Dashboard tools");
    createCustomGroup.mockResolvedValue(created);
    keepSavedView.mockResolvedValue({
      savedView: savedBrowser(browser, "saved-local"),
      group: { id: created.id, name: created.name },
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="confirm-main-browser-keep"]')
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(createCustomGroup).toHaveBeenCalledWith(
      "org-a",
      { name: "Dashboard tools", icon: null },
    ));
  });

  it("persists Main Browser URL, title, and favicon and flushes before Close", async () => {
    const browser = target("browser", "durable-view") as Extract<
      MainWorkbenchTarget,
      { kind: "browser" }
    >;
    const groups = customGroupsWithSavedBrowser(browser, "saved-browser");
    listCustomGroups.mockResolvedValue(groups);
    let finishUpdate!: () => void;
    updateSavedView.mockImplementation(() => new Promise<void>((resolve) => {
      finishUpdate = resolve;
    }));
    renderWorkbench({ runtimeLayer: true });
    act(() => {
      queryClient!.setQueryData(queryKeys.messenger.customGroups("org-a"), groups);
      controls!.openSavedTab("saved-browser", tabDraft(browser));
    });
    act(() => {
      host!
        .querySelector<HTMLButtonElement>('[data-testid="mock-browser-replace"]')
        ?.click();
    });
    act(() => {
      host!
        .querySelector<HTMLButtonElement>('[aria-label="Close Navigated page tab"]')
        ?.click();
    });

    await vi.waitFor(() => expect(updateSavedView).toHaveBeenCalledWith(
      "org-a",
      "saved-browser",
      expect.objectContaining({
        favicon: "https://navigated.example/favicon.ico",
        subtitle: "https://navigated.example",
        title: "Navigated page",
        target: expect.objectContaining({ url: "https://navigated.example" }),
      }),
    ));
    expect(controls!.tabs).toHaveLength(1);
    await act(async () => {
      finishUpdate();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(controls!.tabs).toHaveLength(0));
    expect(navigate).toHaveBeenLastCalledWith("/messenger", { replace: true });
  });

  it("keeps Remove and Close orthogonal and cancels queued metadata after unbind", async () => {
    const browser = target("browser", "removed-view") as Extract<
      MainWorkbenchTarget,
      { kind: "browser" }
    >;
    const groups = customGroupsWithSavedBrowser(browser, "saved-remove");
    listCustomGroups.mockResolvedValue(groups);
    renderWorkbench({ runtimeLayer: true });
    act(() => {
      queryClient!.setQueryData(queryKeys.messenger.customGroups("org-a"), groups);
      controls!.openSavedTab("saved-remove", tabDraft(browser));
    });
    act(() => {
      host!
        .querySelector<HTMLButtonElement>('[data-testid="mock-browser-replace"]')
        ?.click();
    });
    act(() => {
      queryClient!.setQueryData(
        queryKeys.messenger.customGroups("org-a"),
        { groups: [] },
      );
      controls!.unbindSavedView(browser.viewInstanceId, "saved-remove");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(updateSavedView).not.toHaveBeenCalled();
    expect(controls!.tabs).toHaveLength(1);
    expect(controls!.activeTab).toMatchObject({
      savedViewId: null,
      target: { label: "Navigated page" },
    });
    expect(navigate).toHaveBeenLastCalledWith(
      "/messenger/workbench",
      { replace: true },
    );
  });

  it("routes popup, guest close, and guest tab cycling through the Main owner", () => {
    renderWorkbench({ runtimeLayer: true });
    const first = target("browser", "first") as Extract<
      MainWorkbenchTarget,
      { kind: "browser" }
    >;
    const second = target("browser", "second") as Extract<
      MainWorkbenchTarget,
      { kind: "browser" }
    >;
    act(() => {
      controls!.createSessionBrowser(first);
      controls!.createSessionBrowser(second);
    });
    navigate.mockClear();

    act(() => {
      host!
        .querySelector<HTMLButtonElement>(
          '[data-testid="live-surface-runtime-host"][aria-hidden="false"] [data-testid="mock-browser-cycle"]',
        )
        ?.click();
    });
    expect(controls!.activeViewInstanceId).toBe("first");

    act(() => {
      host!
        .querySelector<HTMLButtonElement>('[data-testid="mock-browser-open"]')
        ?.click();
    });
    expect(controls!.activeTab?.target).toMatchObject({
      label: "Popup",
      viewInstanceId: "popup-view",
    });
    expect(navigate).toHaveBeenLastCalledWith(
      "/messenger/workbench",
      { replace: true },
    );

    act(() => {
      host!
        .querySelector<HTMLElement>(
          '[data-testid="mock-browser-live-surface"][data-label="Popup"]',
        )
        ?.querySelector<HTMLButtonElement>('[data-testid="mock-browser-close"]')
        ?.click();
    });
    expect(controls!.tabs).toHaveLength(2);
  });

  it("shows a visible failure when a Main-owned Browser popup reaches shared capacity", () => {
    renderWorkbench({ runtimeLayer: true });
    act(() => {
      for (let index = 0; index < 8; index += 1) {
        controls!.createSessionBrowser(target(
          "browser",
          `capacity-${index}`,
        ) as Extract<MainWorkbenchTarget, { kind: "browser" }>);
      }
    });

    act(() => {
      host!
        .querySelector<HTMLButtonElement>(
          '[data-testid="live-surface-runtime-host"][aria-hidden="false"] [data-testid="mock-browser-open"]',
        )
        ?.click();
    });

    expect(controls!.tabs).toHaveLength(8);
    expect(pushToast).toHaveBeenCalledWith({
      title: "Browser tab limit reached",
      body: "Close a Browser tab to open another. Side Panel and Main share 8 live tabs.",
      tone: "error",
    });
  });

  it("opens an Automation-linked chat instead of swallowing the workbench callback", () => {
    renderWorkbench({ runtimeLayer: true });
    openKinds(["browser"]);

    act(() => {
      host
        ?.querySelector<HTMLButtonElement>('[data-testid="mock-open-linked-chat"]')
        ?.click();
    });

    expect(navigate).toHaveBeenLastCalledWith(
      "/messenger/chat/automation-linked-chat",
    );
  });

  it("owns Cmd/Ctrl+T, Cmd/Ctrl+W, and Ctrl+Tab while focus is in Main", async () => {
    renderWorkbench({ runtimeLayer: true });
    openKinds(["browser", "library_document"]);
    act(() => controls!.focusTab("view-0"));
    const runtimeControl = host!.querySelector<HTMLButtonElement>(
      '[data-testid="mock-browser-replace"]',
    )!;
    runtimeControl.focus();
    expect(runtimeControl.closest("[data-testid='messenger-main-workbench']"))
      .toBeNull();
    navigate.mockClear();

    act(() => {
      runtimeControl.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Tab",
        ctrlKey: true,
      }));
    });
    expect(controls!.activeViewInstanceId).toBe("view-1");

    act(() => {
      runtimeControl.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "t",
        metaKey: true,
      }));
    });
    expect(controls!.tabs).toHaveLength(3);
    expect(controls!.activeTab?.target.kind).toBe("browser");

    await act(async () => {
      runtimeControl.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "w",
        metaKey: true,
      }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(controls!.tabs).toHaveLength(2));
  });

  it("does not dispose or auto-claim a runtime while promotion detach is in flight", () => {
    const browser = target("browser", "promoting") as Extract<
      MainWorkbenchTarget,
      { kind: "browser" }
    >;
    renderWorkbench({
      initialState: detachingPromotionState(browser),
      runtimeLayer: true,
      sideTarget: browser,
    });
    const physical = host!.querySelector('[data-testid="mock-browser-live-surface"]');
    expect(
      host!
        .querySelector('[data-testid="live-surface-runtime-host"]')
        ?.getAttribute("data-owner-id"),
    ).toContain("side:");

    act(() => {
      host!
        .querySelector<HTMLButtonElement>('[aria-label="Close Browser tab"]')
        ?.click();
    });
    expect(controls!.tabs).toHaveLength(1);
    expect(host!.querySelector('[data-testid="mock-browser-live-surface"]'))
      .toBe(physical);
  });
});

// @vitest-environment jsdom

import { LiveSurfaceAnchor, LiveSurfaceRuntimeProvider, createLiveSurfaceRuntimeId, useLiveSurfaceRuntime, type LiveSurfaceTarget } from "@/context/LiveSurfaceRuntimeContext";
import { MainWorkbenchProvider, useOrganizationMainWorkbench } from "@/context/MainWorkbenchContext";
import { SidePanelProvider, useSidePanel } from "@/context/SidePanelContext";
import type { MessengerSavedViewKeepInput } from "@/lib/messenger-saved-views";
import { queryKeys } from "@/lib/queryKeys";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import type { MessengerCustomGroupsResponse, MessengerSavedViewKeepResult } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SavedViewPromotionProvider,
  useSavedViewPromotion,
} from "./SavedViewPromotionContext";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const keepSavedView = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const routeState = vi.hoisted(() => ({ pathname: "/messenger/workbench" }));
const organizationSelection = vi.hoisted(() => {
  let selectedOrganizationId: string | null = "org-a";
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => selectedOrganizationId,
    reset: () => {
      selectedOrganizationId = "org-a";
    },
    set: (next: string | null) => {
      selectedOrganizationId = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("@/api/messenger", () => ({
  messengerApi: { keepSavedView },
}));
vi.mock("@/context/OrganizationContext", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useOptionalOrganization: () => ({
      selectedOrganizationId: useSyncExternalStore(
        organizationSelection.subscribe,
        organizationSelection.getSnapshot,
        organizationSelection.getSnapshot,
      ),
    }),
  };
});
vi.mock("@/lib/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/router")>()),
  useLocation: () => ({ pathname: routeState.pathname }),
  useNavigate: () => navigate,
}));

const contextKey = "chat:chat-a";
const otherContextKey = "chat:chat-other";
const organizationId = "org-a";
const targetA = browser("A", "https://example.com/a");
const targetB = browser("B", "https://example.com/b");
const targetC = browser("C", "https://example.com/c");
const result = keepResult(targetB);
const keepInput: MessengerSavedViewKeepInput = {
  target: {
    kind: "browser",
    tabId: targetB.tabId,
    url: targetB.url,
    viewInstanceId: targetB.viewInstanceId!,
  },
  title: targetB.label,
  subtitle: targetB.url,
  favicon: null,
  clientMutationId: "mutation-a",
  placement: {
    kind: "anchor",
    anchor: { kind: "chat", conversationId: "chat-a" },
  },
};

function browser(label: string, url: string) {
  const suffix = label.toLowerCase();
  return {
    kind: "browser" as const,
    tabId: `tab-${suffix}`,
    viewInstanceId: `view-${suffix}`,
    label,
    url,
  };
}

function keepResult(
  target: Extract<SidePanelTarget, { kind: "browser" }>,
): MessengerSavedViewKeepResult {
  const now = new Date("2026-07-24T00:00:00.000Z");
  return {
    savedView: {
      id: "saved-b",
      orgId: organizationId,
      userId: "user-a",
      targetKind: "browser",
      targetPayload: {
        kind: "browser",
        tabId: target.tabId,
        url: target.url,
        viewInstanceId: target.viewInstanceId!,
      },
      resourceKey: `browser:${target.tabId}`,
      instanceId: target.viewInstanceId!,
      canonicalResourceKey: `browser:${target.tabId}`,
      clientMutationId: "mutation-a",
      title: target.label,
      subtitle: target.url,
      favicon: null,
      sortOrder: 0,
      hiddenAt: null,
      createdAt: now,
      updatedAt: now,
    },
    group: { id: "group-a", name: "Research" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function Harness({
  mainAnchor = true,
  mutateSourceBeforeDetach = false,
  existingResult = null,
  runtimeTargetBeforePromote = null,
}: {
  mainAnchor?: boolean;
  mutateSourceBeforeDetach?: boolean;
  existingResult?: MessengerSavedViewKeepResult | null;
  runtimeTargetBeforePromote?: SidePanelTarget | null;
}) {
  const sidePanel = useSidePanel();
  const workbench = useOrganizationMainWorkbench(organizationId);
  const promotion = useSavedViewPromotion();
  const liveSurfaceRuntime = useLiveSurfaceRuntime();
  const initializedRef = useRef(false);
  const mutatedRef = useRef(false);
  const [outcome, setOutcome] = useState("idle");
  const [otherOutcome, setOtherOutcome] = useState("idle");
  const [mainAnchorMounted, setMainAnchorMounted] = useState(mainAnchor);

  useLayoutEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    sidePanel.openTargetForContext(contextKey, targetA);
    sidePanel.openTargetForContext(contextKey, targetB);
    sidePanel.openTargetForContext(contextKey, targetC);
    sidePanel.openTargetForContext(otherContextKey, targetB);
    sidePanel.showPanelForContext(contextKey);
  }, [sidePanel]);

  useEffect(() => {
    if (
      mutateSourceBeforeDetach
      && workbench.tabs.length > 0
      && !mutatedRef.current
    ) {
      mutatedRef.current = true;
      sidePanel.replaceTargetForContext(
        contextKey,
        sidePanelTargetKey(targetB),
        { ...targetB, label: "B changed" },
      );
    }
  }, [
    mutateSourceBeforeDetach,
    sidePanel,
    workbench.tabs.length,
  ]);

  const trackPromotion = (promise: Promise<MessengerSavedViewKeepResult>) => {
    activePromotionPromise = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  };
  const currentTarget = () => sidePanel.tabs.find(
    (candidate) => sidePanelTargetKey(candidate) === sidePanelTargetKey(targetB),
  ) ?? targetB;

  const promote = async () => {
    setOutcome("pending");
    try {
      if (runtimeTargetBeforePromote) {
        liveSurfaceRuntime.updateTarget(
          createLiveSurfaceRuntimeId(organizationId, targetB as LiveSurfaceTarget),
          runtimeTargetBeforePromote as LiveSurfaceTarget,
        );
      }
      await trackPromotion(promotion.promote({
        contextKey,
        existingResult,
        input: keepInput,
        organizationId,
        target: currentTarget(),
      }));
      setOutcome("moved");
    } catch (error) {
      setOutcome(error instanceof Error ? error.message : "failed");
    }
  };
  const retry = async () => {
    setOutcome("retrying");
    try {
      await trackPromotion(promotion.retry(
        organizationId,
        contextKey,
        currentTarget(),
      ));
      setOutcome("moved");
    } catch (error) {
      setOutcome(error instanceof Error ? error.message : "failed");
    }
  };
  const promoteOtherContext = async () => {
    try {
      await promotion.promote({
        contextKey: otherContextKey,
        existingResult,
        input: keepInput,
        organizationId,
        target: targetB,
      });
      setOtherOutcome("moved");
    } catch (error) {
      setOtherOutcome(error instanceof Error ? error.message : "failed");
    }
  };
  const exactTarget = currentTarget();
  const moveState = promotion.getMoveState(
    organizationId,
    contextKey,
    exactTarget,
  );

  return (
    <>
      {sidePanel.tabs.flatMap((target) => {
        if (
          target.kind !== "browser"
          || !target.viewInstanceId
        ) return [];
        const runtimeId = createLiveSurfaceRuntimeId(
          organizationId,
          target as LiveSurfaceTarget,
        );
        const ownerId = `side:${contextKey}:${runtimeId}`;
        return (
          <LiveSurfaceAnchor
            key={runtimeId}
            active
            hostId={ownerId}
            ownerId={ownerId}
            runtimeId={runtimeId}
            target={target as LiveSurfaceTarget}
          />
        );
      })}
      {mainAnchorMounted ? workbench.tabs.map((tab) => {
        const ownerId = `main:${organizationId}:${tab.viewInstanceId}`;
        return (
          <LiveSurfaceAnchor
            key={ownerId}
            active
            autoClaim={false}
            hostId={ownerId}
            ownerId={ownerId}
            runtimeId={tab.runtimeId}
            target={tab.target}
          />
        );
      }) : null}
      <button type="button" onClick={() => void promote()}>
        Move B
      </button>
      <button type="button" onClick={() => void retry()}>
        Retry move
      </button>
      <button
        type="button"
        onClick={() => {
          activeOtherPromotionPromise = promoteOtherContext();
        }}
      >
        Move B elsewhere
      </button>
      <button
        type="button"
        onClick={() => promotion.discard(
          organizationId,
          contextKey,
          currentTarget(),
        )}
      >
        Abandon move
      </button>
      <button type="button" onClick={() => setMainAnchorMounted(true)}>
        Mount Main
      </button>
      <button
        type="button"
        onClick={() => promotion.setSavedViewRemovalPending(
          organizationId,
          result.savedView.id,
          true,
        )}
      >
        Begin remove
      </button>
      <button
        type="button"
        onClick={() => promotion.finalizeSavedViewRemoval(
          organizationId,
          result.savedView.id,
        )}
      >
        Finish remove
      </button>
      <button
        type="button"
        onClick={() => promotion.setSavedViewRemovalPending(
          organizationId,
          result.savedView.id,
          false,
        )}
      >
        Fail remove
      </button>
      <button
        type="button"
        data-testid="mutate-source"
        onClick={() => sidePanel.replaceTargetForContext(
          contextKey,
          sidePanelTargetKey(targetB),
          { ...targetB, label: "B changed" },
        )}
      >
        Mutate B
      </button>
      <output data-testid="outcome">{outcome}</output>
      <output data-testid="moving">
        {String(promotion.isMoving(organizationId, contextKey, targetB))}
      </output>
      <output data-testid="side-order">
        {sidePanel.tabs.map((target) => target.label).join(",")}
      </output>
      <output data-testid="main-order">
        {workbench.tabs.map((tab) => tab.target.label).join(",")}
      </output>
      <output data-testid="move-status">{moveState.status}</output>
      <output data-testid="promotion-id">{moveState.promotionId ?? ""}</output>
      <output data-testid="other-outcome">{otherOutcome}</output>
      <output data-testid="runtime-host">
        {workbench.runtimesById[createLiveSurfaceRuntimeId(
          organizationId,
          targetB as LiveSurfaceTarget,
        )]?.host.kind ?? ""}
      </output>
      <output data-testid="runtime-locked">
        {String(liveSurfaceRuntime.listRecords().find((record) => (
          record.runtimeId === createLiveSurfaceRuntimeId(
            organizationId,
            targetB as LiveSurfaceTarget,
          )
        ))?.interactionLocked ?? false)}
      </output>
    </>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;
let activePromotionPromise: Promise<void> | null = null;
let activeOtherPromotionPromise: Promise<void> | null = null;
let browserResetListener: (() => void) | null = null;

function renderHarness(
  props: Parameters<typeof Harness>[0] = {},
  persistenceTimeoutMs = 500,
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <LiveSurfaceRuntimeProvider>
          <MainWorkbenchProvider>
            <SidePanelProvider>
              <SavedViewPromotionProvider
                claimTimeoutMs={200}
                persistenceTimeoutMs={persistenceTimeoutMs}
              >
                <Harness {...props} />
              </SavedViewPromotionProvider>
            </SidePanelProvider>
          </MainWorkbenchProvider>
        </LiveSurfaceRuntimeProvider>
      </QueryClientProvider>,
    );
  });
}

async function clickButton(label: string) {
  await act(async () => {
    Array.from(host!.querySelectorAll("button"))
      .find((button) => button.textContent === label)
      ?.click();
    await Promise.resolve();
  });
}

async function settlePromotion() {
  const pending = activePromotionPromise;
  expect(pending).not.toBeNull();
  await act(async () => {
    await pending;
  });
}

async function settleOtherPromotion() {
  const pending = activeOtherPromotionPromise;
  expect(pending).not.toBeNull();
  await act(async () => {
    await pending;
  });
}

async function waitForText(testId: string, expected: string) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      host?.querySelector(`[data-testid="${testId}"]`)?.textContent,
    ).toContain(expected);
  });
}

beforeEach(() => {
  organizationSelection.reset();
  keepSavedView.mockReset().mockResolvedValue(result);
  navigate.mockReset();
  routeState.pathname = "/messenger/workbench";
  browserResetListener = null;
  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    value: {
      onBrowserReset: vi.fn((listener: () => void) => {
        browserResetListener = listener;
        return () => {
          browserResetListener = null;
        };
      }),
      setSidePanelCloseShortcutActive: vi.fn(async () => undefined),
    },
  });
  rectSpy = vi.spyOn(
    HTMLElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue({
    bottom: 300,
    height: 300,
    left: 0,
    right: 400,
    top: 0,
    width: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  act(() => root?.unmount());
  queryClient?.clear();
  host?.remove();
  root = null;
  host = null;
  queryClient = null;
  rectSpy?.mockRestore();
  rectSpy = null;
  activePromotionPromise = null;
  activeOtherPromotionPromise = null;
  browserResetListener = null;
  Reflect.deleteProperty(window, "desktopShell");
});

describe("SavedViewPromotionProvider", () => {
  it("moves and persists the latest live Browser target when the Side target lags", async () => {
    const latestTarget = {
      ...targetB,
      label: "B latest",
      url: "https://example.com/b#latest",
    };
    renderHarness({ runtimeTargetBeforePromote: latestTarget });
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();

    expect(keepSavedView).toHaveBeenCalledWith(
      organizationId,
      expect.objectContaining({
        target: expect.objectContaining({
          url: latestTarget.url,
          viewInstanceId: targetB.viewInstanceId,
        }),
        subtitle: latestTarget.url,
        title: latestTarget.label,
      }),
    );
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe(latestTarget.label);
  });

  it("moves only the exact B instance and preserves A/C order", async () => {
    renderHarness();
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();

    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("B");
    expect(navigate).toHaveBeenCalledWith("/messenger/saved/saved-b");
  });

  it("locks the exact instance while the server mutation is pending", async () => {
    const pending = deferred<MessengerSavedViewKeepResult>();
    keepSavedView.mockReturnValue(pending.promise);
    renderHarness();
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await waitForText("moving", "true");

    await act(async () => pending.resolve(result));
    await settlePromotion();
    expect(host?.querySelector('[data-testid="moving"]')?.textContent)
      .toBe("false");
  });

  it("keeps a late organization-A move out of organization B", async () => {
    const pending = deferred<MessengerSavedViewKeepResult>();
    keepSavedView.mockReturnValue(pending.promise);
    renderHarness();
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await waitForText("moving", "true");

    await act(async () => organizationSelection.set("org-b"));
    await act(async () => pending.resolve(result));
    await settlePromotion();

    expect(navigate).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,B,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("");
    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("claim_failed");
    expect(host?.querySelector('[data-testid="runtime-host"]')?.textContent)
      .toBe("side");
  });

  it("rejects the same runtime from another context without unlocking or rehosting the first move", async () => {
    const pending = deferred<MessengerSavedViewKeepResult>();
    keepSavedView.mockReturnValue(pending.promise);
    renderHarness();
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await waitForText("moving", "true");

    await clickButton("Move B elsewhere");
    await settleOtherPromotion();
    await waitForText("other-outcome", "already moving");

    expect(keepSavedView).toHaveBeenCalledTimes(1);
    expect(host?.querySelector('[data-testid="runtime-host"]')?.textContent)
      .toBe("transferring");
    expect(host?.querySelector('[data-testid="runtime-locked"]')?.textContent)
      .toBe("true");
    expect(host?.querySelector('[data-testid="moving"]')?.textContent)
      .toBe("true");

    await act(async () => pending.resolve(result));
    await settlePromotion();
  });

  it("preserves only the exact in-flight Browser source through a Desktop reset", async () => {
    const pending = deferred<MessengerSavedViewKeepResult>();
    keepSavedView.mockReturnValue(pending.promise);
    renderHarness();
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await waitForText("moving", "true");

    await act(async () => browserResetListener?.());

    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("B");
    expect(host?.querySelector('[data-testid="runtime-host"]')?.textContent)
      .toBe("transferring");
    expect(host?.querySelector('[data-testid="runtime-locked"]')?.textContent)
      .toBe("true");

    await act(async () => pending.resolve(result));
    await settlePromotion();
    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("B");
  });

  it("keeps the source in Side when the server explicitly fails", async () => {
    const { ApiError } = await import("@/api/client");
    keepSavedView.mockRejectedValue(
      new ApiError("Server rejected", 500, null),
    );
    renderHarness();
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();

    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,B,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("retains both the durable row and Side source when Main claim fails", async () => {
    renderHarness({ mainAnchor: false });
    queryClient?.setQueryData<MessengerCustomGroupsResponse>(
      queryKeys.messenger.customGroups(organizationId),
      {
        groups: [{
          id: "group-existing",
          orgId: organizationId,
          userId: "user-a",
          name: "Existing",
          icon: null,
          sortOrder: 0,
          collapsed: false,
          pinnedAt: null,
          createdAt: new Date("2026-07-23T00:00:00.000Z"),
          updatedAt: new Date("2026-07-23T00:00:00.000Z"),
          entries: [],
        }],
      },
    );
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();

    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,B,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("");
    const cached = queryClient?.getQueryData<MessengerCustomGroupsResponse>(
      queryKeys.messenger.customGroups(organizationId),
    );
    const cachedEntry = cached?.groups
      .flatMap((group) => group.entries)
      .find((entry) => entry.item.type === "saved_view");
    expect(cachedEntry?.item.type).toBe("saved_view");
    expect(cachedEntry?.itemKey)
      .toBe("saved-view:saved-b");
    expect(cached?.groups.some((group) => group.id === "group-existing"))
      .toBe(true);
  });

  it("cancels a retained claim retry when its Saved View is removed", async () => {
    renderHarness({ mainAnchor: false });
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();
    await waitForText("move-status", "claim_failed");

    await clickButton("Begin remove");
    await clickButton("Finish remove");

    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,B,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("");
    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("idle");
    expect(host?.querySelector('[data-testid="runtime-host"]')?.textContent)
      .toBe("side");
    expect(host?.querySelector('[data-testid="runtime-locked"]')?.textContent)
      .toBe("false");

    await clickButton("Retry move");
    expect(host?.querySelector('[data-testid="outcome"]')?.textContent)
      .toContain("no retained move");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("");
  });

  it("prevents a late Main claim from detaching Side after Remove succeeds", async () => {
    renderHarness({ mainAnchor: false });
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await waitForText("move-status", "detaching");

    await clickButton("Begin remove");
    await clickButton("Finish remove");
    await clickButton("Fail remove");
    await settlePromotion();

    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,B,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("");
    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("idle");
    expect(host?.querySelector('[data-testid="runtime-host"]')?.textContent)
      .toBe("side");
    expect(host?.querySelector('[data-testid="runtime-locked"]')?.textContent)
      .toBe("false");
  });

  it("keeps an absent groups cache non-synthetic and invalidates it after server commit", async () => {
    renderHarness({ mainAnchor: false });
    const invalidate = vi.spyOn(queryClient!, "invalidateQueries");
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();

    expect(queryClient?.getQueryData(
      queryKeys.messenger.customGroups(organizationId),
    )).toBeUndefined();
    expect(queryClient?.getQueryData(
      queryKeys.messenger.savedView(organizationId, result.savedView.id),
    )).toEqual(result.savedView);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.messenger.customGroups(organizationId),
    });
  });

  it("does not let a hung custom-groups refetch block the committed move", async () => {
    renderHarness();
    const observer = new QueryObserver(queryClient!, {
      queryKey: queryKeys.messenger.customGroups(organizationId),
      queryFn: () => new Promise<MessengerCustomGroupsResponse>(
        () => undefined,
      ),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(observer.getCurrentResult().fetchStatus).toBe("fetching");
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");

    await vi.waitFor(() => {
      expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
        .toBe("B");
    }, { timeout: 300 });
    await settlePromotion();
    unsubscribe();
  });

  it("rolls back Main when the exact source revision changes before detach", async () => {
    renderHarness({ mutateSourceBeforeDetach: true });
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();

    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,B changed,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("");
  });

  it("binds an existing Saved View without creating a duplicate", async () => {
    renderHarness({ existingResult: result });
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();

    expect(keepSavedView).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("B");
  });

  it("times out hung persistence without aborting it and ignores a late settlement", async () => {
    const pending = deferred<MessengerSavedViewKeepResult>();
    keepSavedView.mockReturnValue(pending.promise);
    renderHarness({}, 10);
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();

    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("commit_unknown");
    expect(host?.querySelector('[data-testid="moving"]')?.textContent)
      .toBe("false");
    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,B,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("");

    await act(async () => pending.resolve(result));
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("");
  });

  it("retries a definitive server failure with the retained promotion and mutation id", async () => {
    const { ApiError } = await import("@/api/client");
    keepSavedView
      .mockRejectedValueOnce(new ApiError("Server rejected", 500, null))
      .mockResolvedValueOnce(result);
    renderHarness();
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();
    const promotionId = host?.querySelector(
      '[data-testid="promotion-id"]',
    )?.textContent;

    await clickButton("Retry move");
    await settlePromotion();

    expect(keepSavedView).toHaveBeenCalledTimes(2);
    expect(keepSavedView.mock.calls[1]?.[1].clientMutationId)
      .toBe(keepSavedView.mock.calls[0]?.[1].clientMutationId);
    expect(promotionId).not.toBe("");
    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("B");
  });

  it("reconciles an uncertain commit with the same idempotent request", async () => {
    const pending = deferred<MessengerSavedViewKeepResult>();
    keepSavedView
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(result);
    renderHarness({}, 10);
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();
    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("commit_unknown");

    await clickButton("Retry move");
    await settlePromotion();

    expect(keepSavedView).toHaveBeenCalledTimes(2);
    expect(keepSavedView.mock.calls[1]?.[1].clientMutationId)
      .toBe(keepSavedView.mock.calls[0]?.[1].clientMutationId);
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("B");
    await act(async () => pending.resolve(result));
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("B");
  });

  it("retries only the Main claim after persistence already committed", async () => {
    renderHarness({ mainAnchor: false });
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();
    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("claim_failed");

    await clickButton("Mount Main");
    await clickButton("Retry move");
    await settlePromotion();

    expect(keepSavedView).toHaveBeenCalledTimes(1);
    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,C");
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("B");
  });

  it("discards a stale claim retry so the changed source can start a fresh move", async () => {
    routeState.pathname = "/messenger/saved/saved-b";
    renderHarness({ mainAnchor: false });
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();
    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("claim_failed");

    await clickButton("Mutate B");
    await clickButton("Retry move");
    await settlePromotion();

    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("idle");
    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,B changed,C");
    expect(navigate).toHaveBeenCalledWith(
      "/messenger/workbench",
      { replace: true },
    );

    await clickButton("Mount Main");
    await clickButton("Move B");
    await settlePromotion();
    expect(host?.querySelector('[data-testid="main-order"]')?.textContent)
      .toBe("B changed");
  });

  it("abandons a terminal retained source and leaves the active saved route before disposal", async () => {
    routeState.pathname = "/messenger/saved/saved-b";
    renderHarness({ mainAnchor: false });
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();
    await clickButton("Abandon move");

    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("idle");
    expect(host?.querySelector('[data-testid="runtime-locked"]')?.textContent)
      .toBe("false");
    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("A,B,C");
    expect(navigate).toHaveBeenCalledWith(
      "/messenger/workbench",
      { replace: true },
    );
  });

  it("discards a committed claim failure before Desktop reset removes its Browser source", async () => {
    routeState.pathname = "/messenger/saved/saved-b";
    renderHarness({ mainAnchor: false });
    await waitForText("side-order", "A,B,C");
    await clickButton("Move B");
    await settlePromotion();
    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("claim_failed");

    await act(async () => browserResetListener?.());

    expect(host?.querySelector('[data-testid="move-status"]')?.textContent)
      .toBe("idle");
    expect(host?.querySelector('[data-testid="side-order"]')?.textContent)
      .toBe("");
    expect(queryClient?.getQueryData(
      queryKeys.messenger.savedView(organizationId, result.savedView.id),
    )).toEqual(result.savedView);
    expect(navigate).toHaveBeenCalledWith(
      "/messenger/workbench",
      { replace: true },
    );
  });
});

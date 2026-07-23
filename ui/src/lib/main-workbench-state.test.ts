import { describe, expect, it } from "vitest";
import {
  createMainWorkbenchState,
  MAIN_WORKBENCH_BROWSER_CAPACITY,
  mainWorkbenchLiveBrowserCount,
  mainWorkbenchReducer,
  type MainWorkbenchState,
  type MainWorkbenchTabDraft,
  type MainWorkbenchTarget,
} from "./main-workbench-state";

const ORGANIZATION_A = "organization-a";
const ORGANIZATION_B = "organization-b";

function browserTarget(
  viewInstanceId: string,
  url = `https://example.com/${viewInstanceId}`,
): Extract<MainWorkbenchTarget, { kind: "browser" }> {
  return {
    kind: "browser",
    tabId: `browser-${viewInstanceId}`,
    viewInstanceId,
    url,
    label: `Browser ${viewInstanceId}`,
  };
}

function libraryFileTarget(
  viewInstanceId: string,
  filePath = "docs/spec.md",
): Extract<MainWorkbenchTarget, { kind: "library_file" }> {
  return {
    kind: "library_file",
    viewInstanceId,
    filePath,
    label: `File ${viewInstanceId}`,
  };
}

function tabDraft(
  viewInstanceId: string,
  target: MainWorkbenchTarget = browserTarget(viewInstanceId),
  runtimeId = `runtime-${viewInstanceId}`,
): MainWorkbenchTabDraft {
  return {
    viewInstanceId,
    runtimeId,
    target,
    originContextKey: "chat:source",
  };
}

function reduce(
  state: MainWorkbenchState,
  ...actions: Parameters<typeof mainWorkbenchReducer>[1][]
) {
  return actions.reduce(mainWorkbenchReducer, state);
}

function completePromotionActions(
  promotionId: string,
  savedViewId: string,
  expectedSourceRevision: number,
): Parameters<typeof mainWorkbenchReducer>[1][] {
  return [
    {
      type: "promotion/server-commit",
      organizationId: ORGANIZATION_A,
      promotionId,
      savedViewId,
      expectedSourceRevision,
    },
    {
      type: "promotion/claim",
      organizationId: ORGANIZATION_A,
      promotionId,
      savedViewId,
      expectedSourceRevision,
    },
    {
      type: "promotion/detach-succeed",
      organizationId: ORGANIZATION_A,
      promotionId,
      savedViewId,
      expectedSourceRevision,
    },
  ];
}

describe("Main Workbench state", () => {
  it("focuses an existing Saved View tab by exact view instance without replacing its live state", () => {
    const originalTarget = browserTarget("view-a", "https://example.com/original");
    const state = reduce(
      createMainWorkbenchState(),
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-a",
        tab: tabDraft("view-a", originalTarget),
      },
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-a",
        tab: tabDraft(
          "view-a",
          browserTarget("view-a", "https://example.com/stale-fallback"),
          "replacement-runtime",
        ),
      },
    );

    const organization = state.organizations[ORGANIZATION_A]!;
    expect(organization.tabOrder).toEqual(["view-a"]);
    expect(organization.activeViewInstanceId).toBe("view-a");
    expect(organization.tabsByViewInstanceId["view-a"]).toMatchObject({
      organizationId: ORGANIZATION_A,
      viewInstanceId: "view-a",
      savedViewId: "saved-a",
      runtimeId: "runtime-view-a",
      originContextKey: "chat:source",
    });
    expect(organization.tabsByViewInstanceId["view-a"]?.target).toEqual(originalTarget);
    expect(organization.runtimesById).not.toHaveProperty("replacement-runtime");
  });

  it("focuses an exact tab without replacing a different non-null Saved View binding", () => {
    const state = reduce(
      createMainWorkbenchState(),
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-original",
        tab: tabDraft("view-a"),
      },
      {
        type: "session-tab/create",
        organizationId: ORGANIZATION_A,
        tab: tabDraft("view-b"),
      },
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-conflict",
        tab: tabDraft("view-a", browserTarget("view-a"), "conflicting-runtime"),
      },
    );

    const organization = state.organizations[ORGANIZATION_A]!;
    expect(organization.activeViewInstanceId).toBe("view-a");
    expect(organization.tabsByViewInstanceId["view-a"]?.savedViewId).toBe("saved-original");
    expect(organization.runtimesById).not.toHaveProperty("conflicting-runtime");

    const rebound = mainWorkbenchReducer(state, {
      type: "tab/bind-saved-view",
      organizationId: ORGANIZATION_A,
      viewInstanceId: "view-a",
      savedViewId: "saved-conflict",
    });
    expect(rebound).toBe(state);
  });

  it("keeps each Saved View id bound to at most one tab in an organization", () => {
    const state = reduce(
      createMainWorkbenchState(),
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-unique",
        tab: tabDraft("view-a"),
      },
      {
        type: "session-tab/create",
        organizationId: ORGANIZATION_A,
        tab: tabDraft("view-b"),
      },
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-unique",
        tab: tabDraft("view-c"),
      },
    );

    const organization = state.organizations[ORGANIZATION_A]!;
    expect(organization.activeViewInstanceId).toBe("view-a");
    expect(organization.tabOrder).toEqual(["view-a", "view-b"]);
    expect(organization.tabsByViewInstanceId).not.toHaveProperty("view-c");
    expect(organization.runtimesById).not.toHaveProperty("runtime-view-c");

    const duplicateBinding = mainWorkbenchReducer(state, {
      type: "tab/bind-saved-view",
      organizationId: ORGANIZATION_A,
      viewInstanceId: "view-b",
      savedViewId: "saved-unique",
    });
    expect(duplicateBinding).toBe(state);
  });

  it("keeps Browser tabs with the same URL distinct when their view instances differ", () => {
    const sharedUrl = "https://example.com/dashboard";
    const state = reduce(
      createMainWorkbenchState(),
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-a",
        tab: tabDraft("view-a", browserTarget("view-a", sharedUrl)),
      },
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-b",
        tab: tabDraft("view-b", browserTarget("view-b", sharedUrl)),
      },
    );

    const organization = state.organizations[ORGANIZATION_A]!;
    expect(organization.tabOrder).toEqual(["view-a", "view-b"]);
    expect(Object.keys(organization.tabsByViewInstanceId)).toHaveLength(2);
    expect(organization.tabsByViewInstanceId["view-a"]?.savedViewId).toBe("saved-a");
    expect(organization.tabsByViewInstanceId["view-b"]?.savedViewId).toBe("saved-b");
  });

  it("keeps separate views of the same canonical Library resource", () => {
    const state = reduce(
      createMainWorkbenchState(),
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-a",
        tab: tabDraft("view-a", libraryFileTarget("view-a"), "surface-a"),
      },
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-b",
        tab: tabDraft("view-b", libraryFileTarget("view-b"), "surface-b"),
      },
    );

    expect(state.organizations[ORGANIZATION_A]?.tabOrder).toEqual(["view-a", "view-b"]);
  });

  it("creates a session-only tab without inventing a Saved View binding", () => {
    const state = mainWorkbenchReducer(createMainWorkbenchState(), {
      type: "session-tab/create",
      organizationId: ORGANIZATION_A,
      tab: tabDraft("session-a"),
    });

    const organization = state.organizations[ORGANIZATION_A]!;
    expect(organization.activeViewInstanceId).toBe("session-a");
    expect(organization.tabsByViewInstanceId["session-a"]).toMatchObject({
      savedViewId: null,
      runtimeId: "runtime-session-a",
    });
    expect(organization.runtimesById["runtime-session-a"]?.host).toEqual({
      kind: "main",
      organizationId: ORGANIZATION_A,
    });
  });

  it("reorders Main tabs inside one organization without changing another organization", () => {
    let state = createMainWorkbenchState();
    for (const organizationId of [ORGANIZATION_A, ORGANIZATION_B]) {
      for (const viewInstanceId of ["one", "two", "three"]) {
        state = mainWorkbenchReducer(state, {
          type: "session-tab/create",
          organizationId,
          tab: tabDraft(
            viewInstanceId,
            libraryFileTarget(viewInstanceId, `${organizationId}/spec.md`),
            `${organizationId}-${viewInstanceId}`,
          ),
        });
      }
    }

    const organizationBBefore = state.organizations[ORGANIZATION_B];
    state = mainWorkbenchReducer(state, {
      type: "tab/reorder",
      organizationId: ORGANIZATION_A,
      viewInstanceId: "three",
      toIndex: 0,
    });

    expect(state.organizations[ORGANIZATION_A]?.tabOrder).toEqual(["three", "one", "two"]);
    expect(state.organizations[ORGANIZATION_B]).toBe(organizationBBefore);
    expect(state.organizations[ORGANIZATION_B]?.tabOrder).toEqual(["one", "two", "three"]);
  });

  it("binds and unbinds a Saved View without replacing the tab, target, or runtime", () => {
    const initial = mainWorkbenchReducer(createMainWorkbenchState(), {
      type: "session-tab/create",
      organizationId: ORGANIZATION_A,
      tab: tabDraft("view-a", libraryFileTarget("view-a"), "surface-a"),
    });
    const initialTab = initial.organizations[ORGANIZATION_A]!.tabsByViewInstanceId["view-a"]!;

    const bound = mainWorkbenchReducer(initial, {
      type: "tab/bind-saved-view",
      organizationId: ORGANIZATION_A,
      viewInstanceId: "view-a",
      savedViewId: "saved-a",
    });
    const boundTab = bound.organizations[ORGANIZATION_A]!.tabsByViewInstanceId["view-a"]!;
    expect(boundTab).toMatchObject({
      viewInstanceId: "view-a",
      savedViewId: "saved-a",
      runtimeId: "surface-a",
    });
    expect(boundTab.target).toBe(initialTab.target);
    expect(bound.organizations[ORGANIZATION_A]?.tabOrder).toEqual(["view-a"]);

    const staleUnbind = mainWorkbenchReducer(bound, {
      type: "tab/unbind-saved-view",
      organizationId: ORGANIZATION_A,
      viewInstanceId: "view-a",
      savedViewId: "an-old-binding",
    });
    expect(staleUnbind).toBe(bound);

    const unbound = mainWorkbenchReducer(bound, {
      type: "tab/unbind-saved-view",
      organizationId: ORGANIZATION_A,
      viewInstanceId: "view-a",
      savedViewId: "saved-a",
    });
    const unboundTab = unbound.organizations[ORGANIZATION_A]!.tabsByViewInstanceId["view-a"]!;
    expect(unboundTab.savedViewId).toBeNull();
    expect(unboundTab.target).toBe(initialTab.target);
    expect(unboundTab.runtimeId).toBe("surface-a");
  });

  it("closes only the tab and live runtime so an external Saved View descriptor can reopen it", () => {
    const savedDescriptor = {
      savedViewId: "saved-a",
      tab: tabDraft("view-a", browserTarget("view-a", "https://example.com/form")),
    };
    const opened = mainWorkbenchReducer(createMainWorkbenchState(), {
      type: "saved-tab/open",
      organizationId: ORGANIZATION_A,
      ...savedDescriptor,
    });
    const closed = mainWorkbenchReducer(opened, {
      type: "tab/close",
      organizationId: ORGANIZATION_A,
      viewInstanceId: "view-a",
    });

    expect(closed.organizations[ORGANIZATION_A]?.tabOrder).toEqual([]);
    expect(closed.organizations[ORGANIZATION_A]?.tabsByViewInstanceId).not.toHaveProperty("view-a");
    expect(closed.organizations[ORGANIZATION_A]?.runtimesById["runtime-view-a"]?.host).toEqual({
      kind: "disposed",
    });

    const reopened = mainWorkbenchReducer(closed, {
      type: "saved-tab/open",
      organizationId: ORGANIZATION_A,
      savedViewId: savedDescriptor.savedViewId,
      tab: {
        ...savedDescriptor.tab,
        runtimeId: "runtime-view-a-reopened",
      },
    });
    expect(reopened.organizations[ORGANIZATION_A]?.tabsByViewInstanceId["view-a"]).toMatchObject({
      savedViewId: "saved-a",
      runtimeId: "runtime-view-a-reopened",
    });
  });

  it("models side, parked, crashed, and disposed runtime hosts without changing tab identity", () => {
    const sourceHost = { kind: "side" as const, contextKey: "chat:source" };
    let state = mainWorkbenchReducer(createMainWorkbenchState(), {
      type: "runtime/admit",
      organizationId: ORGANIZATION_A,
      runtime: {
        id: "runtime-a",
        viewInstanceId: "view-a",
        targetKind: "browser",
        target: browserTarget("view-a"),
        host: sourceHost,
      },
    });
    sourceHost.contextKey = "chat:mutated-after-dispatch";
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-a"]?.host).toEqual({
      kind: "side",
      contextKey: "chat:source",
    });

    for (const host of [
      { kind: "parked" as const },
      { kind: "crashed" as const },
      { kind: "disposed" as const },
    ]) {
      state = mainWorkbenchReducer(state, {
        type: "runtime/set-host",
        organizationId: ORGANIZATION_A,
        runtimeId: "runtime-a",
        host,
      });
      expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-a"]?.host).toEqual(host);
      expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-a"]).toMatchObject({
        id: "runtime-a",
        viewInstanceId: "view-a",
      });
    }
  });

  it("admits at most one live runtime for an organization and view instance", () => {
    const firstLive = mainWorkbenchReducer(createMainWorkbenchState(), {
      type: "runtime/admit",
      organizationId: ORGANIZATION_A,
      runtime: {
        id: "runtime-first",
        viewInstanceId: "view-shared",
        targetKind: "browser",
        target: browserTarget("view-shared"),
        host: { kind: "side", contextKey: "chat:first" },
      },
    });
    const rejectedSecondLive = mainWorkbenchReducer(firstLive, {
      type: "runtime/admit",
      organizationId: ORGANIZATION_A,
      runtime: {
        id: "runtime-second",
        viewInstanceId: "view-shared",
        targetKind: "browser",
        target: browserTarget("view-shared"),
        host: { kind: "parked" },
      },
    });
    expect(rejectedSecondLive).toBe(firstLive);
    expect(rejectedSecondLive.organizations[ORGANIZATION_A]?.runtimesById).not.toHaveProperty(
      "runtime-second",
    );

    const withDisposedAlternative = mainWorkbenchReducer(firstLive, {
      type: "runtime/admit",
      organizationId: ORGANIZATION_A,
      runtime: {
        id: "runtime-second",
        viewInstanceId: "view-shared",
        targetKind: "browser",
        target: browserTarget("view-shared"),
        host: { kind: "disposed" },
      },
    });
    const rejectedActivation = mainWorkbenchReducer(withDisposedAlternative, {
      type: "runtime/set-host",
      organizationId: ORGANIZATION_A,
      runtimeId: "runtime-second",
      host: { kind: "main", organizationId: ORGANIZATION_A },
    });
    expect(rejectedActivation).toBe(withDisposedAlternative);
    expect(
      rejectedActivation.organizations[ORGANIZATION_A]?.runtimesById["runtime-second"]?.host,
    ).toEqual({ kind: "disposed" });
  });

  it("promotes the exact source snapshot through transferring to the organization Main host", () => {
    const sourceTarget = browserTarget("view-source", "https://example.com/exact-source");
    let state = mainWorkbenchReducer(createMainWorkbenchState(), {
      type: "runtime/admit",
      organizationId: ORGANIZATION_A,
      runtime: {
        id: "runtime-source",
        viewInstanceId: "view-source",
        targetKind: "browser",
        target: sourceTarget,
        host: { kind: "side", contextKey: "chat:source" },
      },
    });
    state = mainWorkbenchReducer(state, {
      type: "promotion/start",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      source: {
        viewInstanceId: "view-source",
        savedViewId: null,
        sourceRevision: 1,
        runtimeId: "runtime-source",
        target: sourceTarget,
        originContextKey: "chat:source",
      },
      clientMutationId: "mutation-source",
    });

    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "transferring",
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]?.status).toBe("pending");

    sourceTarget.url = "https://example.com/mutated-after-dispatch";
    sourceTarget.label = "Mutated";
    state = reduce(state, ...completePromotionActions("promotion-a", "saved-source", 1));

    expect(state.organizations[ORGANIZATION_A]?.promotionsById).not.toHaveProperty("promotion-a");
    expect(state.organizations[ORGANIZATION_A]?.tabsByViewInstanceId["view-source"]).toMatchObject({
      savedViewId: "saved-source",
      target: {
        url: "https://example.com/exact-source",
        label: "Browser view-source",
      },
      originContextKey: "chat:source",
      runtimeId: "runtime-source",
    });
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "main",
      organizationId: ORGANIZATION_A,
    });
  });

  it("restores the exact Side host and a retryable failure when promotion persistence fails", () => {
    const source = {
      viewInstanceId: "view-source",
      savedViewId: null,
      sourceRevision: 1,
      runtimeId: "runtime-source",
      target: libraryFileTarget("view-source"),
      originContextKey: "issue:RUD-42",
    };
    let state = reduce(
      createMainWorkbenchState(),
      {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: "runtime-source",
          viewInstanceId: "view-source",
          targetKind: "library_file",
          target: source.target,
          host: { kind: "side", contextKey: "issue:RUD-42" },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        source,
        clientMutationId: "mutation-source",
      },
      {
        type: "promotion/server-fail",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        expectedSourceRevision: 1,
        error: "Keep request failed",
      },
    );

    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "side",
      contextKey: "issue:RUD-42",
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "server_failed",
      clientMutationId: "mutation-source",
      error: "Keep request failed",
      source: {
        viewInstanceId: "view-source",
        originContextKey: "issue:RUD-42",
        sourceRevision: 1,
      },
    });
    expect(state.organizations[ORGANIZATION_A]?.tabOrder).toEqual([]);

    state = mainWorkbenchReducer(state, {
      type: "promotion/retry",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      expectedSourceRevision: 1,
      nextSourceRevision: 2,
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]?.status).toBe("pending");
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      clientMutationId: "mutation-source",
      source: { sourceRevision: 2 },
    });
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "transferring",
    });
  });

  it("separates timeout uncertainty from definitive failure and reconciles with the same mutation id", () => {
    const source = {
      viewInstanceId: "view-source",
      savedViewId: null,
      sourceRevision: 1,
      runtimeId: "runtime-source",
      target: browserTarget("view-source"),
      originContextKey: "chat:source",
    };
    let state = reduce(
      createMainWorkbenchState(),
      {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: "runtime-source",
          viewInstanceId: "view-source",
          targetKind: "browser",
          target: source.target,
          host: { kind: "side", contextKey: "chat:source" },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        source,
        clientMutationId: "mutation-stable",
      },
      {
        type: "promotion/timeout",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        expectedSourceRevision: 1,
        error: "Keep response timed out",
      },
    );

    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "commit_unknown",
      clientMutationId: "mutation-stable",
      source: { sourceRevision: 1 },
    });
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "side",
      contextKey: "chat:source",
    });

    state = mainWorkbenchReducer(state, {
      type: "promotion/reconcile",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      expectedSourceRevision: 1,
      nextSourceRevision: 2,
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "reconciling",
      clientMutationId: "mutation-stable",
      source: { sourceRevision: 2 },
    });
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "transferring",
    });

    const staleCompletion = mainWorkbenchReducer(state, {
      type: "promotion/server-commit",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      savedViewId: "saved-source",
      expectedSourceRevision: 1,
    });
    expect(staleCompletion).toBe(state);

    state = reduce(state, ...completePromotionActions("promotion-a", "saved-source", 2));
    expect(state.organizations[ORGANIZATION_A]?.promotionsById).not.toHaveProperty("promotion-a");
    expect(state.organizations[ORGANIZATION_A]?.tabsByViewInstanceId).toHaveProperty("view-source");
  });

  it("ignores every stale terminal transition by source revision", () => {
    const source = {
      viewInstanceId: "view-source",
      savedViewId: null,
      sourceRevision: 7,
      runtimeId: "runtime-source",
      target: browserTarget("view-source"),
      originContextKey: "chat:source",
    };
    const started = reduce(
      createMainWorkbenchState(),
      {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: "runtime-source",
          viewInstanceId: "view-source",
          targetKind: "browser",
          target: source.target,
          host: { kind: "side", contextKey: "chat:source" },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        source,
        clientMutationId: "mutation-source",
      },
    );

    const staleTerminalActions = [
      {
        type: "promotion/server-commit" as const,
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-source",
        expectedSourceRevision: 6,
      },
      {
        type: "promotion/server-fail" as const,
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        error: "definitive failure",
        expectedSourceRevision: 6,
      },
      {
        type: "promotion/timeout" as const,
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        error: "timeout",
        expectedSourceRevision: 6,
      },
      {
        type: "promotion/claim-fail" as const,
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-source",
        error: "claim failed",
        expectedSourceRevision: 6,
      },
    ];
    for (const action of staleTerminalActions) {
      expect(mainWorkbenchReducer(started, action)).toBe(started);
    }
  });

  it("ignores every terminal transition unless the source runtime is still transferring", () => {
    const terminalActions = [
      {
        type: "promotion/server-commit" as const,
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-source",
        expectedSourceRevision: 1,
      },
      {
        type: "promotion/server-fail" as const,
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        error: "definitive failure",
        expectedSourceRevision: 1,
      },
      {
        type: "promotion/timeout" as const,
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        error: "timeout",
        expectedSourceRevision: 1,
      },
      {
        type: "promotion/claim-fail" as const,
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-source",
        error: "claim failed",
        expectedSourceRevision: 1,
      },
    ];

    for (const terminalAction of terminalActions) {
      const started = reduce(
        createMainWorkbenchState(),
        {
          type: "runtime/admit",
          organizationId: ORGANIZATION_A,
          runtime: {
            id: "runtime-source",
            viewInstanceId: "view-source",
            targetKind: "browser",
            target: browserTarget("view-source"),
            host: { kind: "side", contextKey: "chat:source" },
          },
        },
        {
          type: "promotion/start",
          organizationId: ORGANIZATION_A,
          promotionId: "promotion-a",
          clientMutationId: "mutation-source",
          source: {
            viewInstanceId: "view-source",
            savedViewId: null,
            sourceRevision: 1,
            runtimeId: "runtime-source",
            target: browserTarget("view-source"),
            originContextKey: "chat:source",
          },
        },
        {
          type: "runtime/set-host",
          organizationId: ORGANIZATION_A,
          runtimeId: "runtime-source",
          host: { kind: "crashed" },
        },
      );

      expect(mainWorkbenchReducer(started, terminalAction)).toBe(started);
    }
  });

  it("retains a committed Saved View binding for retry when the Main host claim fails", () => {
    const source = {
      viewInstanceId: "view-source",
      savedViewId: null,
      sourceRevision: 1,
      runtimeId: "runtime-source",
      target: browserTarget("view-source"),
      originContextKey: "chat:source",
    };
    const state = reduce(
      createMainWorkbenchState(),
      {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: "runtime-source",
          viewInstanceId: "view-source",
          targetKind: "browser",
          target: source.target,
          host: { kind: "side", contextKey: "chat:source" },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        source,
        clientMutationId: "mutation-source",
      },
      {
        type: "promotion/server-commit",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-committed",
        expectedSourceRevision: 1,
      },
      {
        type: "promotion/claim-fail",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-committed",
        expectedSourceRevision: 1,
        error: "Main anchor timed out",
      },
    );

    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "claim_failed",
      clientMutationId: "mutation-source",
      savedViewId: "saved-committed",
      error: "Main anchor timed out",
    });
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "side",
      contextKey: "chat:source",
    });
    expect(state.organizations[ORGANIZATION_A]?.tabsByViewInstanceId).not.toHaveProperty("view-source");

    const retryingClaim = mainWorkbenchReducer(state, {
      type: "promotion/claim-retry",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      expectedSourceRevision: 1,
      nextSourceRevision: 2,
    });
    expect(retryingClaim.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "claiming",
      clientMutationId: "mutation-source",
      savedViewId: "saved-committed",
      source: { sourceRevision: 2 },
    });
    expect(
      retryingClaim.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host,
    ).toEqual({ kind: "transferring" });

    const completed = reduce(
      retryingClaim,
      {
        type: "promotion/claim",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-committed",
        expectedSourceRevision: 2,
      },
      {
        type: "promotion/detach-succeed",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-committed",
        expectedSourceRevision: 2,
      },
    );
    expect(completed.organizations[ORGANIZATION_A]?.promotionsById).not.toHaveProperty(
      "promotion-a",
    );
    expect(completed.organizations[ORGANIZATION_A]?.tabsByViewInstanceId["view-source"]).toMatchObject({
      savedViewId: "saved-committed",
      runtimeId: "runtime-source",
    });
  });

  it("focuses and binds an existing exact Main tab while transferring the exact source runtime", () => {
    let state = reduce(
      createMainWorkbenchState(),
      {
        type: "session-tab/create",
        organizationId: ORGANIZATION_A,
        tab: tabDraft("view-source", browserTarget("view-source"), "runtime-main"),
      },
      {
        type: "runtime/set-host",
        organizationId: ORGANIZATION_A,
        runtimeId: "runtime-main",
        host: { kind: "disposed" },
      },
      {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: "runtime-source",
          viewInstanceId: "view-source",
          targetKind: "browser",
          target: browserTarget("view-source"),
          host: { kind: "side", contextKey: "chat:source" },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        clientMutationId: "mutation-source",
        source: {
          viewInstanceId: "view-source",
          savedViewId: null,
          sourceRevision: 1,
          runtimeId: "runtime-source",
          target: browserTarget("view-source"),
          originContextKey: "chat:source",
        },
      },
      ...completePromotionActions("promotion-a", "saved-source", 1),
    );

    const organization = state.organizations[ORGANIZATION_A]!;
    expect(organization.promotionsById).not.toHaveProperty("promotion-a");
    expect(organization.tabOrder).toEqual(["view-source"]);
    expect(organization.activeViewInstanceId).toBe("view-source");
    expect(organization.tabsByViewInstanceId["view-source"]).toMatchObject({
      savedViewId: "saved-source",
      runtimeId: "runtime-source",
    });
    expect(organization.runtimesById["runtime-main"]?.host).toEqual({
      kind: "disposed",
    });
    expect(organization.runtimesById["runtime-source"]?.host).toEqual({
      kind: "main",
      organizationId: ORGANIZATION_A,
    });
    expect(mainWorkbenchLiveBrowserCount(state, ORGANIZATION_A)).toBe(1);
  });

  it("clears a successful promotion that is already satisfied by the exact tab and binding", () => {
    const state = reduce(
      createMainWorkbenchState(),
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-source",
        tab: tabDraft("view-source", browserTarget("view-source"), "runtime-source"),
      },
      {
        type: "runtime/set-host",
        organizationId: ORGANIZATION_A,
        runtimeId: "runtime-source",
        host: { kind: "side", contextKey: "chat:source" },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        clientMutationId: "mutation-source",
        source: {
          viewInstanceId: "view-source",
          savedViewId: "saved-source",
          sourceRevision: 1,
          runtimeId: "runtime-source",
          target: browserTarget("view-source"),
          originContextKey: "chat:source",
        },
      },
      ...completePromotionActions("promotion-a", "saved-source", 1),
    );

    const organization = state.organizations[ORGANIZATION_A]!;
    expect(organization.promotionsById).not.toHaveProperty("promotion-a");
    expect(organization.tabOrder).toEqual(["view-source"]);
    expect(organization.activeViewInstanceId).toBe("view-source");
    expect(organization.tabsByViewInstanceId["view-source"]?.savedViewId).toBe("saved-source");
    expect(organization.runtimesById["runtime-source"]?.host).toEqual({
      kind: "main",
      organizationId: ORGANIZATION_A,
    });
  });

  it("resolves a conflicting Saved binding without replacing it or leaving promotion pending", () => {
    let state = reduce(
      createMainWorkbenchState(),
      {
        type: "saved-tab/open",
        organizationId: ORGANIZATION_A,
        savedViewId: "saved-original",
        tab: tabDraft("view-source", browserTarget("view-source"), "runtime-main"),
      },
      {
        type: "runtime/set-host",
        organizationId: ORGANIZATION_A,
        runtimeId: "runtime-main",
        host: { kind: "disposed" },
      },
      {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: "runtime-source",
          viewInstanceId: "view-source",
          targetKind: "browser",
          target: browserTarget("view-source"),
          host: { kind: "side", contextKey: "chat:source" },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        clientMutationId: "mutation-source",
        source: {
          viewInstanceId: "view-source",
          savedViewId: null,
          sourceRevision: 1,
          runtimeId: "runtime-source",
          target: browserTarget("view-source"),
          originContextKey: "chat:source",
        },
      },
      {
        type: "promotion/server-commit",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-conflict",
        expectedSourceRevision: 1,
      },
      {
        type: "promotion/claim",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-conflict",
        expectedSourceRevision: 1,
      },
    );

    const organization = state.organizations[ORGANIZATION_A]!;
    expect(organization.activeViewInstanceId).toBe("view-source");
    expect(organization.tabsByViewInstanceId["view-source"]?.savedViewId).toBe("saved-original");
    expect(organization.promotionsById["promotion-a"]).toMatchObject({
      status: "claim_failed",
      savedViewId: "saved-conflict",
      error: "saved_view_binding_conflict",
    });
    expect(organization.runtimesById["runtime-source"]?.host).toEqual({
      kind: "side",
      contextKey: "chat:source",
    });
  });

  it("shares eight live Browser slots per organization while transfers neither increment nor evict", () => {
    let state = createMainWorkbenchState();
    for (let index = 0; index < MAIN_WORKBENCH_BROWSER_CAPACITY; index += 1) {
      state = mainWorkbenchReducer(state, {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: `runtime-${index}`,
          viewInstanceId: `view-${index}`,
          targetKind: "browser",
          target: browserTarget(`view-${index}`),
          host: index === MAIN_WORKBENCH_BROWSER_CAPACITY - 1
            ? { kind: "parked" }
            : { kind: "side", contextKey: `chat:${index}` },
        },
      });
    }
    expect(mainWorkbenchLiveBrowserCount(state, ORGANIZATION_A)).toBe(
      MAIN_WORKBENCH_BROWSER_CAPACITY,
    );

    state = mainWorkbenchReducer(state, {
      type: "promotion/start",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-zero",
      source: {
        viewInstanceId: "view-0",
        savedViewId: null,
        sourceRevision: 1,
        runtimeId: "runtime-0",
        target: browserTarget("view-0"),
        originContextKey: "chat:0",
      },
      clientMutationId: "mutation-zero",
    });
    expect(mainWorkbenchLiveBrowserCount(state, ORGANIZATION_A)).toBe(
      MAIN_WORKBENCH_BROWSER_CAPACITY,
    );

    const beforeNewTab = state;
    state = mainWorkbenchReducer(state, {
      type: "session-tab/create",
      organizationId: ORGANIZATION_A,
      tab: tabDraft("new-view", browserTarget("new-view"), "new-runtime"),
    });
    expect(state).toBe(beforeNewTab);

    const beforeColdSavedView = state;
    state = mainWorkbenchReducer(state, {
      type: "saved-tab/open",
      organizationId: ORGANIZATION_A,
      savedViewId: "cold-saved",
      tab: tabDraft("cold-view", browserTarget("cold-view"), "cold-runtime"),
    });
    expect(state).toBe(beforeColdSavedView);
    expect(state.organizations[ORGANIZATION_A]?.runtimesById).not.toHaveProperty("new-runtime");
    expect(state.organizations[ORGANIZATION_A]?.runtimesById).not.toHaveProperty("cold-runtime");
    expect(Object.keys(state.organizations[ORGANIZATION_A]!.runtimesById)).toEqual(
      Array.from({ length: MAIN_WORKBENCH_BROWSER_CAPACITY }, (_, index) => `runtime-${index}`),
    );

    state = reduce(state, ...completePromotionActions("promotion-zero", "saved-zero", 1));
    expect(mainWorkbenchLiveBrowserCount(state, ORGANIZATION_A)).toBe(
      MAIN_WORKBENCH_BROWSER_CAPACITY,
    );
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-0"]?.host).toEqual({
      kind: "main",
      organizationId: ORGANIZATION_A,
    });
  });

  it("isolates identical tab and runtime identities, active state, and capacity between organizations", () => {
    let state = createMainWorkbenchState();
    for (const organizationId of [ORGANIZATION_A, ORGANIZATION_B]) {
      state = mainWorkbenchReducer(state, {
        type: "session-tab/create",
        organizationId,
        tab: tabDraft("shared-view", browserTarget("shared-view"), "shared-runtime"),
      });
    }
    for (let index = 1; index < MAIN_WORKBENCH_BROWSER_CAPACITY; index += 1) {
      state = mainWorkbenchReducer(state, {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: `organization-a-runtime-${index}`,
          viewInstanceId: `organization-a-view-${index}`,
          targetKind: "browser",
          target: browserTarget(`organization-a-view-${index}`),
          host: { kind: "parked" },
        },
      });
    }

    const organizationBBefore = state.organizations[ORGANIZATION_B];
    state = reduce(
      state,
      {
        type: "tab/bind-saved-view",
        organizationId: ORGANIZATION_A,
        viewInstanceId: "shared-view",
        savedViewId: "saved-only-in-a",
      },
      {
        type: "session-tab/create",
        organizationId: ORGANIZATION_B,
        tab: tabDraft("second-b", browserTarget("second-b"), "second-runtime-b"),
      },
    );

    expect(state.organizations[ORGANIZATION_A]?.tabsByViewInstanceId["shared-view"]?.savedViewId).toBe(
      "saved-only-in-a",
    );
    expect(state.organizations[ORGANIZATION_A]?.tabsByViewInstanceId).not.toHaveProperty("second-b");
    expect(state.organizations[ORGANIZATION_B]).not.toBe(organizationBBefore);
    expect(state.organizations[ORGANIZATION_B]?.tabsByViewInstanceId["shared-view"]?.savedViewId).toBeNull();
    expect(state.organizations[ORGANIZATION_B]?.tabsByViewInstanceId).toHaveProperty("second-b");
    expect(mainWorkbenchLiveBrowserCount(state, ORGANIZATION_A)).toBe(
      MAIN_WORKBENCH_BROWSER_CAPACITY,
    );
    expect(mainWorkbenchLiveBrowserCount(state, ORGANIZATION_B)).toBe(2);
  });

  it("stages a committed promotion before claiming Main and only finalizes after Side detach", () => {
    const source = {
      viewInstanceId: "view-source",
      savedViewId: null,
      sourceRevision: 3,
      runtimeId: "runtime-source",
      target: browserTarget("view-source", "https://example.com/claimed"),
      originContextKey: "chat:source",
    };
    let state = reduce(
      createMainWorkbenchState(),
      {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: source.runtimeId,
          viewInstanceId: source.viewInstanceId,
          targetKind: source.target.kind,
          target: source.target,
          host: { kind: "side", contextKey: source.originContextKey },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        clientMutationId: "mutation-a",
        source,
      },
    );

    state = mainWorkbenchReducer(state, {
      type: "promotion/server-commit",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      savedViewId: "saved-a",
      expectedSourceRevision: 3,
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "claiming",
      savedViewId: "saved-a",
    });
    expect(state.organizations[ORGANIZATION_A]?.tabsByViewInstanceId).not.toHaveProperty(
      "view-source",
    );
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "transferring",
    });

    state = mainWorkbenchReducer(state, {
      type: "promotion/claim",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      savedViewId: "saved-a",
      expectedSourceRevision: 3,
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "detaching",
      savedViewId: "saved-a",
    });
    expect(state.organizations[ORGANIZATION_A]?.tabsByViewInstanceId["view-source"]).toMatchObject({
      savedViewId: "saved-a",
      runtimeId: "runtime-source",
      target: source.target,
    });
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "main",
      organizationId: ORGANIZATION_A,
    });

    state = mainWorkbenchReducer(state, {
      type: "promotion/detach-succeed",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      savedViewId: "saved-a",
      expectedSourceRevision: 3,
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById).not.toHaveProperty("promotion-a");
    expect(state.organizations[ORGANIZATION_A]?.tabsByViewInstanceId["view-source"]?.savedViewId).toBe(
      "saved-a",
    );
  });

  it("rolls a provisional Main claim back to the exact Side host and retains its commit for retry", () => {
    const source = {
      viewInstanceId: "view-source",
      savedViewId: null,
      sourceRevision: 4,
      runtimeId: "runtime-source",
      target: browserTarget("view-source"),
      originContextKey: "issue:RUD-42",
    };
    let state = reduce(
      createMainWorkbenchState(),
      {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: source.runtimeId,
          viewInstanceId: source.viewInstanceId,
          targetKind: source.target.kind,
          target: source.target,
          host: { kind: "side", contextKey: source.originContextKey },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        clientMutationId: "mutation-a",
        source,
      },
      {
        type: "promotion/server-commit",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-committed",
        expectedSourceRevision: 4,
      },
      {
        type: "promotion/claim",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-committed",
        expectedSourceRevision: 4,
      },
    );

    state = mainWorkbenchReducer(state, {
      type: "promotion/detach-fail",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      savedViewId: "saved-committed",
      expectedSourceRevision: 4,
      error: "source revision changed",
    });

    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "claim_failed",
      savedViewId: "saved-committed",
      clientMutationId: "mutation-a",
      error: "source revision changed",
    });
    expect(state.organizations[ORGANIZATION_A]?.tabsByViewInstanceId).not.toHaveProperty(
      "view-source",
    );
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "side",
      contextKey: "issue:RUD-42",
    });

    state = mainWorkbenchReducer(state, {
      type: "promotion/claim-retry",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      expectedSourceRevision: 4,
      nextSourceRevision: 5,
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "claiming",
      savedViewId: "saved-committed",
      source: { sourceRevision: 5 },
    });
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "transferring",
    });
  });

  it("updates runtime and tab targets only for the exact runtime and view instance", () => {
    const originalTarget = browserTarget("view-a", "https://example.com/original");
    const nextTarget = browserTarget("view-a", "https://example.com/next");
    const initial = mainWorkbenchReducer(createMainWorkbenchState(), {
      type: "session-tab/create",
      organizationId: ORGANIZATION_A,
      tab: tabDraft("view-a", originalTarget, "runtime-a"),
    });

    const staleRuntime = mainWorkbenchReducer(initial, {
      type: "runtime/update-target",
      organizationId: ORGANIZATION_A,
      runtimeId: "runtime-a",
      viewInstanceId: "stale-view",
      target: nextTarget,
    });
    expect(staleRuntime).toBe(initial);

    const runtimeUpdated = mainWorkbenchReducer(initial, {
      type: "runtime/update-target",
      organizationId: ORGANIZATION_A,
      runtimeId: "runtime-a",
      viewInstanceId: "view-a",
      target: nextTarget,
    });
    expect(runtimeUpdated.organizations[ORGANIZATION_A]?.runtimesById["runtime-a"]?.target).toEqual(
      nextTarget,
    );
    expect(runtimeUpdated.organizations[ORGANIZATION_A]?.tabsByViewInstanceId["view-a"]?.target).toEqual(
      originalTarget,
    );

    const staleTab = mainWorkbenchReducer(runtimeUpdated, {
      type: "tab/update-target",
      organizationId: ORGANIZATION_A,
      runtimeId: "stale-runtime",
      viewInstanceId: "view-a",
      target: nextTarget,
    });
    expect(staleTab).toBe(runtimeUpdated);

    const tabUpdated = mainWorkbenchReducer(runtimeUpdated, {
      type: "tab/update-target",
      organizationId: ORGANIZATION_A,
      runtimeId: "runtime-a",
      viewInstanceId: "view-a",
      target: nextTarget,
    });
    expect(tabUpdated.organizations[ORGANIZATION_A]?.tabsByViewInstanceId["view-a"]?.target).toEqual(
      nextTarget,
    );
  });

  it("discards only the exact terminal promotion attempt", () => {
    const source = {
      viewInstanceId: "view-source",
      savedViewId: null,
      sourceRevision: 3,
      runtimeId: "runtime-source",
      target: browserTarget("view-source"),
      originContextKey: "chat:source",
    };
    const failed = reduce(
      createMainWorkbenchState(),
      {
        type: "runtime/admit",
        organizationId: ORGANIZATION_A,
        runtime: {
          id: "runtime-source",
          viewInstanceId: "view-source",
          targetKind: "browser",
          target: source.target,
          host: { kind: "side", contextKey: "chat:source" },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        source,
        clientMutationId: "mutation-a",
      },
      {
        type: "promotion/server-fail",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        expectedSourceRevision: 3,
        error: "failed",
      },
    );

    const staleDiscard = mainWorkbenchReducer(failed, {
      type: "promotion/discard",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      expectedSourceRevision: 2,
    });
    expect(staleDiscard).toBe(failed);

    const discarded = mainWorkbenchReducer(failed, {
      type: "promotion/discard",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      expectedSourceRevision: 3,
    });
    expect(discarded.organizations[ORGANIZATION_A]?.promotionsById)
      .not.toHaveProperty("promotion-a");
    expect(
      discarded.organizations[ORGANIZATION_A]
        ?.runtimesById["runtime-source"]?.host,
    ).toEqual({ kind: "side", contextKey: "chat:source" });
  });
});

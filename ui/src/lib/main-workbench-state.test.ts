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
    let state = mainWorkbenchReducer(createMainWorkbenchState(), {
      type: "runtime/admit",
      organizationId: ORGANIZATION_A,
      runtime: {
        id: "runtime-a",
        viewInstanceId: "view-a",
        targetKind: "browser",
        host: { kind: "side", contextKey: "chat:source" },
      },
    });
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

  it("promotes the exact source snapshot through transferring to the organization Main host", () => {
    const sourceTarget = browserTarget("view-source", "https://example.com/exact-source");
    let state = mainWorkbenchReducer(createMainWorkbenchState(), {
      type: "runtime/admit",
      organizationId: ORGANIZATION_A,
      runtime: {
        id: "runtime-source",
        viewInstanceId: "view-source",
        targetKind: "browser",
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
        runtimeId: "runtime-source",
        target: sourceTarget,
        originContextKey: "chat:source",
      },
    });

    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "transferring",
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]?.status).toBe("pending");

    sourceTarget.url = "https://example.com/mutated-after-dispatch";
    sourceTarget.label = "Mutated";
    state = mainWorkbenchReducer(state, {
      type: "promotion/succeed",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      savedViewId: "saved-source",
    });

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
          host: { kind: "side", contextKey: "issue:RUD-42" },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        source,
      },
      {
        type: "promotion/fail",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        error: "Keep request failed",
      },
    );

    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "side",
      contextKey: "issue:RUD-42",
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "failed",
      error: "Keep request failed",
      source: {
        viewInstanceId: "view-source",
        originContextKey: "issue:RUD-42",
      },
    });
    expect(state.organizations[ORGANIZATION_A]?.tabOrder).toEqual([]);

    state = mainWorkbenchReducer(state, {
      type: "promotion/start",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-a",
      source,
    });
    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]?.status).toBe("pending");
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "transferring",
    });
  });

  it("retains a committed Saved View binding for retry when the Main host claim fails", () => {
    const source = {
      viewInstanceId: "view-source",
      savedViewId: null,
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
          host: { kind: "side", contextKey: "chat:source" },
        },
      },
      {
        type: "promotion/start",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        source,
      },
      {
        type: "promotion/claim-fail",
        organizationId: ORGANIZATION_A,
        promotionId: "promotion-a",
        savedViewId: "saved-committed",
        error: "Main anchor timed out",
      },
    );

    expect(state.organizations[ORGANIZATION_A]?.promotionsById["promotion-a"]).toMatchObject({
      status: "claim_failed",
      savedViewId: "saved-committed",
      error: "Main anchor timed out",
    });
    expect(state.organizations[ORGANIZATION_A]?.runtimesById["runtime-source"]?.host).toEqual({
      kind: "side",
      contextKey: "chat:source",
    });
    expect(state.organizations[ORGANIZATION_A]?.tabsByViewInstanceId).not.toHaveProperty("view-source");
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
        runtimeId: "runtime-0",
        target: browserTarget("view-0"),
        originContextKey: "chat:0",
      },
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

    state = mainWorkbenchReducer(state, {
      type: "promotion/succeed",
      organizationId: ORGANIZATION_A,
      promotionId: "promotion-zero",
      savedViewId: "saved-zero",
    });
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
});

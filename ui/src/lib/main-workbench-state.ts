import type { SidePanelTarget } from "./side-panel-targets";

export const MAIN_WORKBENCH_BROWSER_CAPACITY = 8;

type MainWorkbenchTargetKind =
  | "automation"
  | "browser"
  | "library_directory"
  | "library_document"
  | "library_entry"
  | "library_file"
  | "local_app";

/**
 * A target that can occupy the Main Workbench. Its view instance is required
 * because canonical resource identity and Browser URL never identify a tab.
 */
export type MainWorkbenchTarget = Extract<
  SidePanelTarget,
  { kind: MainWorkbenchTargetKind }
> & {
  viewInstanceId: string;
};

export type MainWorkbenchRuntimeHost =
  | { kind: "side"; contextKey: string }
  | { kind: "transferring" }
  | { kind: "main"; organizationId: string }
  | { kind: "parked" }
  | { kind: "crashed" }
  | { kind: "disposed" };

export type MainWorkbenchRuntimeRecord = {
  id: string;
  organizationId: string;
  viewInstanceId: string;
  targetKind: MainWorkbenchTargetKind;
  target: MainWorkbenchTarget;
  host: MainWorkbenchRuntimeHost;
};

export type MainWorkbenchRuntimeDraft = Omit<
  MainWorkbenchRuntimeRecord,
  "organizationId"
>;

/**
 * Saved View identity is only an optional binding. The organization and view
 * instance together are the tab identity, while runtime identity is separate.
 */
export type MainWorkbenchTab = {
  organizationId: string;
  viewInstanceId: string;
  savedViewId: string | null;
  target: MainWorkbenchTarget;
  originContextKey: string;
  runtimeId: string;
};

export type MainWorkbenchTabDraft = Omit<
  MainWorkbenchTab,
  "organizationId" | "savedViewId"
>;

export type MainWorkbenchPromotionSourceSnapshot = {
  viewInstanceId: string;
  savedViewId: string | null;
  sourceRevision: number;
  target: MainWorkbenchTarget;
  originContextKey: string;
  runtimeId: string;
};

type MainWorkbenchPromotionBase = {
  id: string;
  organizationId: string;
  clientMutationId: string;
  source: MainWorkbenchPromotionSourceSnapshot;
};

type MainWorkbenchPendingPromotion = MainWorkbenchPromotionBase & {
  status: "pending";
};

type MainWorkbenchReconcilingPromotion = MainWorkbenchPromotionBase & {
  status: "reconciling";
};

type MainWorkbenchServerFailedPromotion = MainWorkbenchPromotionBase & {
  status: "server_failed";
  error: string;
};

type MainWorkbenchCommitUnknownPromotion = MainWorkbenchPromotionBase & {
  status: "commit_unknown";
  error: string;
};

type MainWorkbenchClaimFailedPromotion = MainWorkbenchPromotionBase & {
  status: "claim_failed";
  savedViewId: string;
  error: string;
};

type MainWorkbenchClaimingPromotion = MainWorkbenchPromotionBase & {
  status: "claiming";
  savedViewId: string;
};

type MainWorkbenchDetachingPromotion = MainWorkbenchPromotionBase & {
  status: "detaching";
  savedViewId: string;
  rollback: {
    activeViewInstanceId: string | null;
    tab: MainWorkbenchTab | null;
  };
};

/**
 * Successful promotion has no residual attempt record: the resulting tab and
 * its `main` runtime host are the success state. Failures stay here for retry.
 */
export type MainWorkbenchPromotion =
  | MainWorkbenchPendingPromotion
  | MainWorkbenchReconcilingPromotion
  | MainWorkbenchServerFailedPromotion
  | MainWorkbenchCommitUnknownPromotion
  | MainWorkbenchClaimFailedPromotion
  | MainWorkbenchClaimingPromotion
  | MainWorkbenchDetachingPromotion;

export type MainWorkbenchOrganizationState = {
  activeViewInstanceId: string | null;
  tabOrder: string[];
  tabsByViewInstanceId: Record<string, MainWorkbenchTab>;
  runtimesById: Record<string, MainWorkbenchRuntimeRecord>;
  promotionsById: Record<string, MainWorkbenchPromotion>;
};

export type MainWorkbenchState = {
  organizations: Record<string, MainWorkbenchOrganizationState>;
};

export type MainWorkbenchAction =
  | {
      type: "saved-tab/open";
      organizationId: string;
      savedViewId: string;
      tab: MainWorkbenchTabDraft;
    }
  | {
      type: "session-tab/create";
      organizationId: string;
      tab: MainWorkbenchTabDraft;
    }
  | {
      type: "tab/focus";
      organizationId: string;
      viewInstanceId: string;
    }
  | {
      type: "tab/reorder";
      organizationId: string;
      viewInstanceId: string;
      toIndex: number;
    }
  | {
      type: "tab/bind-saved-view";
      organizationId: string;
      viewInstanceId: string;
      savedViewId: string;
    }
  | {
      type: "tab/unbind-saved-view";
      organizationId: string;
      viewInstanceId: string;
      savedViewId: string;
    }
  | {
      type: "tab/close";
      organizationId: string;
      viewInstanceId: string;
    }
  | {
      type: "tab/update-target";
      organizationId: string;
      runtimeId: string;
      viewInstanceId: string;
      target: MainWorkbenchTarget;
    }
  | {
      type: "runtime/admit";
      organizationId: string;
      runtime: MainWorkbenchRuntimeDraft;
    }
  | {
      type: "runtime/set-host";
      organizationId: string;
      runtimeId: string;
      host: MainWorkbenchRuntimeHost;
    }
  | {
      type: "runtime/update-target";
      organizationId: string;
      runtimeId: string;
      viewInstanceId: string;
      target: MainWorkbenchTarget;
    }
  | {
      type: "promotion/start";
      organizationId: string;
      promotionId: string;
      source: MainWorkbenchPromotionSourceSnapshot;
      clientMutationId: string;
    }
  | {
      type: "promotion/server-commit";
      organizationId: string;
      promotionId: string;
      savedViewId: string;
      expectedSourceRevision: number;
    }
  | {
      type: "promotion/claim";
      organizationId: string;
      promotionId: string;
      savedViewId: string;
      expectedSourceRevision: number;
    }
  | {
      type: "promotion/detach-succeed";
      organizationId: string;
      promotionId: string;
      savedViewId: string;
      expectedSourceRevision: number;
    }
  | {
      type: "promotion/detach-fail";
      organizationId: string;
      promotionId: string;
      savedViewId: string;
      expectedSourceRevision: number;
      error: string;
    }
  | {
      type: "promotion/server-fail";
      organizationId: string;
      promotionId: string;
      expectedSourceRevision: number;
      error: string;
    }
  | {
      type: "promotion/timeout";
      organizationId: string;
      promotionId: string;
      expectedSourceRevision: number;
      error: string;
    }
  | {
      type: "promotion/retry";
      organizationId: string;
      promotionId: string;
      expectedSourceRevision: number;
      nextSourceRevision: number;
    }
  | {
      type: "promotion/reconcile";
      organizationId: string;
      promotionId: string;
      expectedSourceRevision: number;
      nextSourceRevision: number;
    }
  | {
      type: "promotion/claim-fail";
      organizationId: string;
      promotionId: string;
      savedViewId: string;
      expectedSourceRevision: number;
      error: string;
    }
  | {
      type: "promotion/claim-retry";
      organizationId: string;
      promotionId: string;
      expectedSourceRevision: number;
      nextSourceRevision: number;
    }
  | {
      type: "promotion/discard";
      organizationId: string;
      promotionId: string;
      expectedSourceRevision: number;
    }
  | {
      type: "promotion/cancel-saved-view";
      organizationId: string;
      promotionId: string;
      savedViewId: string;
      expectedSourceRevision: number;
    };

function emptyOrganizationState(): MainWorkbenchOrganizationState {
  return {
    activeViewInstanceId: null,
    tabOrder: [],
    tabsByViewInstanceId: {},
    runtimesById: {},
    promotionsById: {},
  };
}

export function createMainWorkbenchState(): MainWorkbenchState {
  return { organizations: {} };
}

function isLiveRuntimeHost(host: MainWorkbenchRuntimeHost): boolean {
  return host.kind === "side"
    || host.kind === "transferring"
    || host.kind === "main"
    || host.kind === "parked";
}

export function mainWorkbenchLiveBrowserCount(
  state: MainWorkbenchState,
  organizationId: string,
): number {
  const organization = state.organizations[organizationId];
  if (!organization) return 0;
  return Object.values(organization.runtimesById).filter(
    (runtime) => runtime.targetKind === "browser" && isLiveRuntimeHost(runtime.host),
  ).length;
}

function organizationLiveBrowserCount(
  organization: MainWorkbenchOrganizationState,
): number {
  return Object.values(organization.runtimesById).filter(
    (runtime) => runtime.targetKind === "browser" && isLiveRuntimeHost(runtime.host),
  ).length;
}

function hostsEqual(
  left: MainWorkbenchRuntimeHost,
  right: MainWorkbenchRuntimeHost,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "side" && right.kind === "side") {
    return left.contextKey === right.contextKey;
  }
  if (left.kind === "main" && right.kind === "main") {
    return left.organizationId === right.organizationId;
  }
  return true;
}

function cloneRuntimeHost(
  host: MainWorkbenchRuntimeHost,
): MainWorkbenchRuntimeHost {
  return { ...host };
}

function runtimeCanUseHost(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  runtime: MainWorkbenchRuntimeDraft,
): boolean {
  if (
    !runtime.id
    || !runtime.viewInstanceId
    || runtime.target.viewInstanceId !== runtime.viewInstanceId
    || runtime.target.kind !== runtime.targetKind
    || (runtime.host.kind === "main" && runtime.host.organizationId !== organizationId)
  ) {
    return false;
  }

  const existing = organization.runtimesById[runtime.id];
  if (
    existing
    && (
      existing.viewInstanceId !== runtime.viewInstanceId
      || existing.targetKind !== runtime.targetKind
    )
  ) {
    return false;
  }

  const addsLiveBrowser = runtime.targetKind === "browser"
    && isLiveRuntimeHost(runtime.host)
    && !(existing?.targetKind === "browser" && isLiveRuntimeHost(existing.host));
  if (
    addsLiveBrowser
    && organizationLiveBrowserCount(organization) >= MAIN_WORKBENCH_BROWSER_CAPACITY
  ) {
    return false;
  }

  const conflictsWithLiveView = isLiveRuntimeHost(runtime.host)
    && Object.values(organization.runtimesById).some((candidate) => (
      candidate.id !== runtime.id
      && candidate.viewInstanceId === runtime.viewInstanceId
      && isLiveRuntimeHost(candidate.host)
    ));
  return !conflictsWithLiveView;
}

function withRuntime(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  runtime: MainWorkbenchRuntimeDraft,
): MainWorkbenchOrganizationState {
  if (!runtimeCanUseHost(organization, organizationId, runtime)) return organization;

  const existing = organization.runtimesById[runtime.id];
  if (existing && hostsEqual(existing.host, runtime.host)) return organization;
  return {
    ...organization,
    runtimesById: {
      ...organization.runtimesById,
      [runtime.id]: {
        ...runtime,
        organizationId,
        target: existing?.target ?? cloneTarget(runtime.target),
        host: cloneRuntimeHost(runtime.host),
      },
    },
  };
}

function cloneTarget(target: MainWorkbenchTarget): MainWorkbenchTarget {
  if (target.kind !== "browser" || !target.savedViewRecovery) {
    return { ...target };
  }
  return {
    ...target,
    savedViewRecovery: {
      ...target.savedViewRecovery,
      persistedMetadata: {
        ...target.savedViewRecovery.persistedMetadata,
        target: {
          ...target.savedViewRecovery.persistedMetadata.target,
        },
      },
    },
  };
}

function validTabDraft(tab: MainWorkbenchTabDraft): boolean {
  return Boolean(
    tab.viewInstanceId
    && tab.runtimeId
    && tab.originContextKey
    && tab.target.viewInstanceId === tab.viewInstanceId,
  );
}

type OpenTabResult = {
  organization: MainWorkbenchOrganizationState;
  outcome:
    | "already_satisfied"
    | "binding_conflict"
    | "focused_existing_binding"
    | "opened"
    | "rejected";
};

function tabBoundToSavedView(
  organization: MainWorkbenchOrganizationState,
  savedViewId: string,
): MainWorkbenchTab | null {
  return Object.values(organization.tabsByViewInstanceId).find(
    (tab) => tab.savedViewId === savedViewId,
  ) ?? null;
}

function openTab(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  tab: MainWorkbenchTabDraft,
  savedViewId: string | null,
): OpenTabResult {
  if (!validTabDraft(tab) || (savedViewId !== null && !savedViewId)) {
    return { organization, outcome: "rejected" };
  }

  const boundTab = savedViewId ? tabBoundToSavedView(organization, savedViewId) : null;
  if (boundTab && boundTab.viewInstanceId !== tab.viewInstanceId) {
    if (organization.activeViewInstanceId === boundTab.viewInstanceId) {
      return { organization, outcome: "focused_existing_binding" };
    }
    return {
      organization: {
        ...organization,
        activeViewInstanceId: boundTab.viewInstanceId,
      },
      outcome: "focused_existing_binding",
    };
  }

  const existingTab = organization.tabsByViewInstanceId[tab.viewInstanceId];
  if (existingTab) {
    const bindingConflict = savedViewId !== null
      && existingTab.savedViewId !== null
      && existingTab.savedViewId !== savedViewId;
    const bindingMatches = savedViewId === null
      || existingTab.savedViewId === savedViewId;
    const activeMatches = organization.activeViewInstanceId === tab.viewInstanceId;
    if (bindingMatches && activeMatches) {
      return { organization, outcome: "already_satisfied" };
    }
    const nextOrganization = {
      ...organization,
      activeViewInstanceId: tab.viewInstanceId,
      tabsByViewInstanceId: savedViewId === null
        || bindingMatches
        || bindingConflict
        ? organization.tabsByViewInstanceId
        : {
            ...organization.tabsByViewInstanceId,
            [tab.viewInstanceId]: {
              ...existingTab,
              savedViewId,
            },
          },
    };
    return {
      organization: nextOrganization,
      outcome: bindingConflict ? "binding_conflict" : "already_satisfied",
    };
  }

  const runtime: MainWorkbenchRuntimeDraft = {
    id: tab.runtimeId,
    viewInstanceId: tab.viewInstanceId,
    targetKind: tab.target.kind,
    target: tab.target,
    host: { kind: "main", organizationId },
  };
  if (!runtimeCanUseHost(organization, organizationId, runtime)) {
    return { organization, outcome: "rejected" };
  }
  const withMainRuntime = withRuntime(organization, organizationId, runtime);
  return {
    organization: {
      ...withMainRuntime,
      activeViewInstanceId: tab.viewInstanceId,
      tabOrder: [...withMainRuntime.tabOrder, tab.viewInstanceId],
      tabsByViewInstanceId: {
        ...withMainRuntime.tabsByViewInstanceId,
        [tab.viewInstanceId]: {
          organizationId,
          viewInstanceId: tab.viewInstanceId,
          savedViewId,
          target: cloneTarget(tab.target),
          originContextKey: tab.originContextKey,
          runtimeId: tab.runtimeId,
        },
      },
    },
    outcome: "opened",
  };
}

function updateOrganization(
  state: MainWorkbenchState,
  organizationId: string,
  update: (
    organization: MainWorkbenchOrganizationState,
  ) => MainWorkbenchOrganizationState,
): MainWorkbenchState {
  if (!organizationId) return state;
  const organization = state.organizations[organizationId] ?? emptyOrganizationState();
  const nextOrganization = update(organization);
  if (nextOrganization === organization) return state;
  return {
    ...state,
    organizations: {
      ...state.organizations,
      [organizationId]: nextOrganization,
    },
  };
}

function bindSavedView(
  organization: MainWorkbenchOrganizationState,
  viewInstanceId: string,
  savedViewId: string,
): MainWorkbenchOrganizationState {
  const tab = organization.tabsByViewInstanceId[viewInstanceId];
  if (
    !tab
    || !savedViewId
    || tab.savedViewId === savedViewId
    || tab.savedViewId !== null
    || tabBoundToSavedView(organization, savedViewId)
  ) {
    return organization;
  }
  return {
    ...organization,
    tabsByViewInstanceId: {
      ...organization.tabsByViewInstanceId,
      [viewInstanceId]: {
        ...tab,
        savedViewId,
      },
    },
  };
}

function unbindSavedView(
  organization: MainWorkbenchOrganizationState,
  viewInstanceId: string,
  savedViewId: string,
): MainWorkbenchOrganizationState {
  const tab = organization.tabsByViewInstanceId[viewInstanceId];
  if (!tab || tab.savedViewId !== savedViewId) return organization;
  return {
    ...organization,
    tabsByViewInstanceId: {
      ...organization.tabsByViewInstanceId,
      [viewInstanceId]: {
        ...tab,
        savedViewId: null,
      },
    },
  };
}

function closeTab(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  viewInstanceId: string,
): MainWorkbenchOrganizationState {
  const tab = organization.tabsByViewInstanceId[viewInstanceId];
  if (!tab) return organization;
  const closedIndex = organization.tabOrder.indexOf(viewInstanceId);
  const tabOrder = organization.tabOrder.filter((candidate) => candidate !== viewInstanceId);
  const { [viewInstanceId]: _closed, ...tabsByViewInstanceId } = organization.tabsByViewInstanceId;
  const withDisposedRuntime = withRuntime(organization, organizationId, {
    id: tab.runtimeId,
    viewInstanceId: tab.viewInstanceId,
    targetKind: tab.target.kind,
    target: organization.runtimesById[tab.runtimeId]?.target ?? tab.target,
    host: { kind: "disposed" },
  });
  const activeViewInstanceId = organization.activeViewInstanceId === viewInstanceId
    ? tabOrder[Math.min(Math.max(closedIndex, 0), tabOrder.length - 1)] ?? null
    : organization.activeViewInstanceId;
  return {
    ...withDisposedRuntime,
    activeViewInstanceId,
    tabOrder,
    tabsByViewInstanceId,
  };
}

function reorderTab(
  organization: MainWorkbenchOrganizationState,
  viewInstanceId: string,
  toIndex: number,
): MainWorkbenchOrganizationState {
  const fromIndex = organization.tabOrder.indexOf(viewInstanceId);
  if (fromIndex < 0 || !Number.isFinite(toIndex)) return organization;
  const boundedIndex = Math.max(
    0,
    Math.min(Math.trunc(toIndex), organization.tabOrder.length - 1),
  );
  if (fromIndex === boundedIndex) return organization;
  const tabOrder = [...organization.tabOrder];
  tabOrder.splice(fromIndex, 1);
  tabOrder.splice(boundedIndex, 0, viewInstanceId);
  return { ...organization, tabOrder };
}

function clonePromotionSource(
  source: MainWorkbenchPromotionSourceSnapshot,
): MainWorkbenchPromotionSourceSnapshot {
  return {
    ...source,
    target: cloneTarget(source.target),
  };
}

function validSourceRevision(sourceRevision: number): boolean {
  return Number.isInteger(sourceRevision) && sourceRevision >= 0;
}

function promotionIsInFlight(
  promotion: MainWorkbenchPromotion,
): promotion is MainWorkbenchPendingPromotion
  | MainWorkbenchReconcilingPromotion
  | MainWorkbenchClaimingPromotion
  | MainWorkbenchDetachingPromotion {
  return promotion.status === "pending"
    || promotion.status === "reconciling"
    || promotion.status === "claiming"
    || promotion.status === "detaching";
}

function startPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  source: MainWorkbenchPromotionSourceSnapshot,
  clientMutationId: string,
): MainWorkbenchOrganizationState {
  if (
    !promotionId
    || !clientMutationId
    || !validTabDraft(source)
    || !validSourceRevision(source.sourceRevision)
    || organization.promotionsById[promotionId]
    || Object.values(organization.promotionsById).some(
      (promotion) => (
        promotionIsInFlight(promotion)
        && promotion.source.runtimeId === source.runtimeId
      ),
    )
  ) {
    return organization;
  }

  const runtime = organization.runtimesById[source.runtimeId];
  if (
    !runtime
    || runtime.viewInstanceId !== source.viewInstanceId
    || runtime.targetKind !== source.target.kind
    || runtime.host.kind !== "side"
    || runtime.host.contextKey !== source.originContextKey
  ) {
    return organization;
  }

  const withTransferringRuntime = withRuntime(organization, organizationId, {
    id: runtime.id,
    viewInstanceId: runtime.viewInstanceId,
    targetKind: runtime.targetKind,
    target: runtime.target,
    host: { kind: "transferring" },
  });
  return {
    ...withTransferringRuntime,
    promotionsById: {
      ...withTransferringRuntime.promotionsById,
      [promotionId]: {
        id: promotionId,
        organizationId,
        clientMutationId,
        status: "pending",
        source: clonePromotionSource(source),
      },
    },
  };
}

function restorePromotionSourceHost(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  source: MainWorkbenchPromotionSourceSnapshot,
): MainWorkbenchOrganizationState {
  const runtime = organization.runtimesById[source.runtimeId];
  if (!runtime) return organization;
  return withRuntime(organization, organizationId, {
    id: runtime.id,
    viewInstanceId: runtime.viewInstanceId,
    targetKind: runtime.targetKind,
    target: runtime.target,
    host: { kind: "side", contextKey: source.originContextKey },
  });
}

function terminalPromotion(
  organization: MainWorkbenchOrganizationState,
  promotionId: string,
  expectedSourceRevision: number,
): MainWorkbenchPendingPromotion
  | MainWorkbenchReconcilingPromotion
  | MainWorkbenchClaimingPromotion
  | null {
  const promotion = organization.promotionsById[promotionId];
  if (
    !promotion
    || (
      promotion.status !== "pending"
      && promotion.status !== "reconciling"
      && promotion.status !== "claiming"
    )
    || promotion.source.sourceRevision !== expectedSourceRevision
  ) {
    return null;
  }
  const runtime = organization.runtimesById[promotion.source.runtimeId];
  if (
    !runtime
    || runtime.viewInstanceId !== promotion.source.viewInstanceId
    || runtime.targetKind !== promotion.source.target.kind
    || runtime.host.kind !== "transferring"
  ) {
    return null;
  }
  return promotion;
}

function retryPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  expectedSourceRevision: number,
  nextSourceRevision: number,
): MainWorkbenchOrganizationState {
  const promotion = organization.promotionsById[promotionId];
  if (
    !promotion
    || (promotion.status !== "server_failed" && promotion.status !== "commit_unknown")
    || promotion.source.sourceRevision !== expectedSourceRevision
    || !validSourceRevision(nextSourceRevision)
    || nextSourceRevision <= expectedSourceRevision
  ) {
    return organization;
  }
  const runtime = organization.runtimesById[promotion.source.runtimeId];
  if (
    !runtime
    || runtime.host.kind !== "side"
    || runtime.host.contextKey !== promotion.source.originContextKey
  ) {
    return organization;
  }
  const transferring = withRuntime(organization, organizationId, {
    id: runtime.id,
    viewInstanceId: runtime.viewInstanceId,
    targetKind: runtime.targetKind,
    target: runtime.target,
    host: { kind: "transferring" },
  });
  return {
    ...transferring,
    promotionsById: {
      ...transferring.promotionsById,
      [promotionId]: {
        id: promotion.id,
        organizationId,
        clientMutationId: promotion.clientMutationId,
        status: "pending",
        source: {
          ...promotion.source,
          sourceRevision: nextSourceRevision,
        },
      },
    },
  };
}

function reconcilePromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  expectedSourceRevision: number,
  nextSourceRevision: number,
): MainWorkbenchOrganizationState {
  const promotion = organization.promotionsById[promotionId];
  if (
    !promotion
    || promotion.status !== "commit_unknown"
    || promotion.source.sourceRevision !== expectedSourceRevision
    || !validSourceRevision(nextSourceRevision)
    || nextSourceRevision <= expectedSourceRevision
  ) {
    return organization;
  }
  const runtime = organization.runtimesById[promotion.source.runtimeId];
  if (
    !runtime
    || runtime.host.kind !== "side"
    || runtime.host.contextKey !== promotion.source.originContextKey
  ) {
    return organization;
  }
  const transferring = withRuntime(organization, organizationId, {
    id: runtime.id,
    viewInstanceId: runtime.viewInstanceId,
    targetKind: runtime.targetKind,
    target: runtime.target,
    host: { kind: "transferring" },
  });
  return {
    ...transferring,
    promotionsById: {
      ...transferring.promotionsById,
      [promotionId]: {
        id: promotion.id,
        organizationId,
        clientMutationId: promotion.clientMutationId,
        status: "reconciling",
        source: {
          ...promotion.source,
          sourceRevision: nextSourceRevision,
        },
      },
    },
  };
}

function retryPromotionClaim(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  expectedSourceRevision: number,
  nextSourceRevision: number,
): MainWorkbenchOrganizationState {
  const promotion = organization.promotionsById[promotionId];
  if (
    !promotion
    || promotion.status !== "claim_failed"
    || promotion.source.sourceRevision !== expectedSourceRevision
    || !validSourceRevision(nextSourceRevision)
    || nextSourceRevision <= expectedSourceRevision
  ) {
    return organization;
  }
  const runtime = organization.runtimesById[promotion.source.runtimeId];
  if (
    !runtime
    || runtime.host.kind !== "side"
    || runtime.host.contextKey !== promotion.source.originContextKey
  ) {
    return organization;
  }
  const transferring = withRuntime(organization, organizationId, {
    id: runtime.id,
    viewInstanceId: runtime.viewInstanceId,
    targetKind: runtime.targetKind,
    target: runtime.target,
    host: { kind: "transferring" },
  });
  return {
    ...transferring,
    promotionsById: {
      ...transferring.promotionsById,
      [promotionId]: {
        id: promotion.id,
        organizationId,
        clientMutationId: promotion.clientMutationId,
        status: "claiming",
        savedViewId: promotion.savedViewId,
        source: {
          ...promotion.source,
          sourceRevision: nextSourceRevision,
        },
      },
    },
  };
}

function serverCommitPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  savedViewId: string,
  expectedSourceRevision: number,
): MainWorkbenchOrganizationState {
  const promotion = terminalPromotion(
    organization,
    promotionId,
    expectedSourceRevision,
  );
  if (
    !promotion
    || promotion.status === "claiming"
    || !savedViewId
  ) {
    return organization;
  }
  return {
    ...organization,
    promotionsById: {
      ...organization.promotionsById,
      [promotionId]: {
        id: promotion.id,
        organizationId,
        clientMutationId: promotion.clientMutationId,
        source: promotion.source,
        status: "claiming",
        savedViewId,
      },
    },
  };
}

function serverFailPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  expectedSourceRevision: number,
  error: string,
): MainWorkbenchOrganizationState {
  const promotion = terminalPromotion(
    organization,
    promotionId,
    expectedSourceRevision,
  );
  if (!promotion || promotion.status === "claiming") return organization;
  const restored = restorePromotionSourceHost(
    organization,
    organizationId,
    promotion.source,
  );
  return {
    ...restored,
    promotionsById: {
      ...restored.promotionsById,
      [promotionId]: {
        id: promotion.id,
        organizationId,
        clientMutationId: promotion.clientMutationId,
        source: promotion.source,
        status: "server_failed",
        error,
      },
    },
  };
}

function timeoutPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  expectedSourceRevision: number,
  error: string,
): MainWorkbenchOrganizationState {
  const promotion = terminalPromotion(
    organization,
    promotionId,
    expectedSourceRevision,
  );
  if (!promotion || promotion.status === "claiming") return organization;
  const restored = restorePromotionSourceHost(
    organization,
    organizationId,
    promotion.source,
  );
  return {
    ...restored,
    promotionsById: {
      ...restored.promotionsById,
      [promotionId]: {
        id: promotion.id,
        organizationId,
        clientMutationId: promotion.clientMutationId,
        source: promotion.source,
        status: "commit_unknown",
        error,
      },
    },
  };
}

function claimFailPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  savedViewId: string,
  expectedSourceRevision: number,
  error: string,
): MainWorkbenchOrganizationState {
  const promotion = terminalPromotion(
    organization,
    promotionId,
    expectedSourceRevision,
  );
  if (
    !promotion
    || promotion.status !== "claiming"
    || !savedViewId
    || promotion.savedViewId !== savedViewId
  ) {
    return organization;
  }
  const restored = restorePromotionSourceHost(
    organization,
    organizationId,
    promotion.source,
  );
  return {
    ...restored,
    promotionsById: {
      ...restored.promotionsById,
      [promotionId]: {
        id: promotion.id,
        organizationId,
        clientMutationId: promotion.clientMutationId,
        source: promotion.source,
        status: "claim_failed",
        savedViewId,
        error,
      },
    },
  };
}

function clearPromotion(
  organization: MainWorkbenchOrganizationState,
  promotionId: string,
): MainWorkbenchOrganizationState {
  const { [promotionId]: _completed, ...promotionsById } = organization.promotionsById;
  return {
    ...organization,
    promotionsById,
  };
}

function discardPromotion(
  organization: MainWorkbenchOrganizationState,
  promotionId: string,
  expectedSourceRevision: number,
): MainWorkbenchOrganizationState {
  const promotion = organization.promotionsById[promotionId];
  if (
    !promotion
    || (
      promotion.status !== "server_failed"
      && promotion.status !== "commit_unknown"
      && promotion.status !== "claim_failed"
    )
    || promotion.source.sourceRevision !== expectedSourceRevision
  ) {
    return organization;
  }
  return clearPromotion(organization, promotionId);
}

function cancelSavedViewPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  savedViewId: string,
  expectedSourceRevision: number,
): MainWorkbenchOrganizationState {
  const promotion = organization.promotionsById[promotionId];
  if (
    !promotion
    || promotion.source.sourceRevision !== expectedSourceRevision
    || (
      promotion.source.savedViewId !== savedViewId
      && (
        !("savedViewId" in promotion)
        || promotion.savedViewId !== savedViewId
      )
    )
  ) {
    return organization;
  }

  if (promotion.status === "detaching") {
    const restored = detachFailPromotion(
      organization,
      organizationId,
      promotionId,
      savedViewId,
      expectedSourceRevision,
      "saved_view_removed",
    );
    return clearPromotion(restored, promotionId);
  }
  return clearPromotion(
    restorePromotionSourceHost(
      organization,
      organizationId,
      promotion.source,
    ),
    promotionId,
  );
}

function promotionClaimConflict(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotion: MainWorkbenchClaimingPromotion,
  savedViewId: string,
  error: string,
): MainWorkbenchOrganizationState {
  const restored = restorePromotionSourceHost(
    organization,
    organizationId,
    promotion.source,
  );
  return {
    ...restored,
    promotionsById: {
      ...restored.promotionsById,
      [promotion.id]: {
        id: promotion.id,
        organizationId,
        clientMutationId: promotion.clientMutationId,
        source: promotion.source,
        status: "claim_failed",
        savedViewId,
        error,
      },
    },
  };
}

function cloneTab(tab: MainWorkbenchTab): MainWorkbenchTab {
  return {
    ...tab,
    target: cloneTarget(tab.target),
  };
}

function withDetachingPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotion: MainWorkbenchClaimingPromotion,
  rollback: MainWorkbenchDetachingPromotion["rollback"],
): MainWorkbenchOrganizationState {
  return {
    ...organization,
    promotionsById: {
      ...organization.promotionsById,
      [promotion.id]: {
        ...promotion,
        organizationId,
        status: "detaching",
        rollback,
      },
    },
  };
}

function claimPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  savedViewId: string,
  expectedSourceRevision: number,
): MainWorkbenchOrganizationState {
  const promotion = terminalPromotion(
    organization,
    promotionId,
    expectedSourceRevision,
  );
  if (
    !promotion
    || promotion.status !== "claiming"
    || !savedViewId
    || promotion.savedViewId !== savedViewId
  ) {
    return organization;
  }

  const rollback: MainWorkbenchDetachingPromotion["rollback"] = {
    activeViewInstanceId: organization.activeViewInstanceId,
    tab: organization.tabsByViewInstanceId[promotion.source.viewInstanceId]
      ? cloneTab(organization.tabsByViewInstanceId[promotion.source.viewInstanceId]!)
      : null,
  };
  const exactTab = organization.tabsByViewInstanceId[promotion.source.viewInstanceId];
  const savedBinding = tabBoundToSavedView(organization, savedViewId);
  if (savedBinding && savedBinding.viewInstanceId !== promotion.source.viewInstanceId) {
    const focused = organization.activeViewInstanceId === savedBinding.viewInstanceId
      ? organization
      : {
          ...organization,
          activeViewInstanceId: savedBinding.viewInstanceId,
        };
    return promotionClaimConflict(
      focused,
      organizationId,
      promotion,
      savedViewId,
      "saved_view_already_bound",
    );
  }
  if (
    exactTab?.savedViewId
    && exactTab.savedViewId !== savedViewId
  ) {
    const focused = organization.activeViewInstanceId === exactTab.viewInstanceId
      ? organization
      : {
          ...organization,
          activeViewInstanceId: exactTab.viewInstanceId,
        };
    return promotionClaimConflict(
      focused,
      organizationId,
      promotion,
      savedViewId,
      "saved_view_binding_conflict",
    );
  }

  if (exactTab) {
    let claimed = organization;
    let claimedRuntimeId = exactTab.runtimeId;
    if (exactTab.runtimeId === promotion.source.runtimeId) {
      const sourceRuntime = claimed.runtimesById[promotion.source.runtimeId]!;
      claimed = withRuntime(claimed, organizationId, {
        id: sourceRuntime.id,
        viewInstanceId: sourceRuntime.viewInstanceId,
        targetKind: sourceRuntime.targetKind,
        target: sourceRuntime.target,
        host: { kind: "main", organizationId },
      });
    } else {
      const existingRuntime = claimed.runtimesById[exactTab.runtimeId];
      if (
        !existingRuntime
        || existingRuntime.viewInstanceId !== exactTab.viewInstanceId
        || existingRuntime.targetKind !== exactTab.target.kind
        || isLiveRuntimeHost(existingRuntime.host)
      ) {
        return promotionClaimConflict(
          organization,
          organizationId,
          promotion,
          savedViewId,
          "existing_tab_runtime_unavailable",
        );
      }
      const sourceRuntime = claimed.runtimesById[promotion.source.runtimeId]!;
      claimed = withRuntime(claimed, organizationId, {
        id: sourceRuntime.id,
        viewInstanceId: sourceRuntime.viewInstanceId,
        targetKind: sourceRuntime.targetKind,
        target: sourceRuntime.target,
        host: { kind: "main", organizationId },
      });
      if (claimed.runtimesById[sourceRuntime.id]?.host.kind !== "main") {
        return promotionClaimConflict(
          organization,
          organizationId,
          promotion,
          savedViewId,
          "existing_tab_runtime_unavailable",
        );
      }
      claimedRuntimeId = sourceRuntime.id;
    }
    claimed = {
      ...claimed,
      activeViewInstanceId: exactTab.viewInstanceId,
      tabsByViewInstanceId: exactTab.savedViewId === savedViewId
        && exactTab.runtimeId === claimedRuntimeId
        ? claimed.tabsByViewInstanceId
        : {
            ...claimed.tabsByViewInstanceId,
            [exactTab.viewInstanceId]: {
              ...exactTab,
              savedViewId,
              runtimeId: claimedRuntimeId,
              target: cloneTarget(promotion.source.target),
              originContextKey: promotion.source.originContextKey,
            },
          },
    };
    return withDetachingPromotion(
      claimed,
      organizationId,
      promotion,
      rollback,
    );
  }

  const opened = openTab(
    organization,
    organizationId,
    {
      viewInstanceId: promotion.source.viewInstanceId,
      runtimeId: promotion.source.runtimeId,
      target: promotion.source.target,
      originContextKey: promotion.source.originContextKey,
    },
    savedViewId,
  );
  if (opened.outcome !== "opened") {
    return promotionClaimConflict(
      opened.organization,
      organizationId,
      promotion,
      savedViewId,
      opened.outcome === "binding_conflict"
        ? "saved_view_binding_conflict"
        : "main_host_claim_rejected",
    );
  }
  return withDetachingPromotion(
    opened.organization,
    organizationId,
    promotion,
    rollback,
  );
}

function detachingPromotion(
  organization: MainWorkbenchOrganizationState,
  promotionId: string,
  savedViewId: string,
  expectedSourceRevision: number,
): MainWorkbenchDetachingPromotion | null {
  const promotion = organization.promotionsById[promotionId];
  if (
    !promotion
    || promotion.status !== "detaching"
    || promotion.savedViewId !== savedViewId
    || promotion.source.sourceRevision !== expectedSourceRevision
  ) {
    return null;
  }
  const runtime = organization.runtimesById[promotion.source.runtimeId];
  const tab = organization.tabsByViewInstanceId[promotion.source.viewInstanceId];
  if (
    !runtime
    || runtime.viewInstanceId !== promotion.source.viewInstanceId
    || runtime.host.kind !== "main"
    || runtime.host.organizationId !== promotion.organizationId
    || !tab
    || tab.runtimeId !== runtime.id
    || tab.savedViewId !== savedViewId
  ) {
    return null;
  }
  return promotion;
}

function detachSucceedPromotion(
  organization: MainWorkbenchOrganizationState,
  promotionId: string,
  savedViewId: string,
  expectedSourceRevision: number,
): MainWorkbenchOrganizationState {
  const promotion = detachingPromotion(
    organization,
    promotionId,
    savedViewId,
    expectedSourceRevision,
  );
  return promotion ? clearPromotion(organization, promotion.id) : organization;
}

function detachFailPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  savedViewId: string,
  expectedSourceRevision: number,
  error: string,
): MainWorkbenchOrganizationState {
  const promotion = detachingPromotion(
    organization,
    promotionId,
    savedViewId,
    expectedSourceRevision,
  );
  if (!promotion) return organization;

  const restoredHost = restorePromotionSourceHost(
    organization,
    organizationId,
    promotion.source,
  );
  const tabsByViewInstanceId = {
    ...restoredHost.tabsByViewInstanceId,
  };
  let tabOrder = restoredHost.tabOrder;
  if (promotion.rollback.tab) {
    tabsByViewInstanceId[promotion.source.viewInstanceId] = cloneTab(
      promotion.rollback.tab,
    );
  } else {
    delete tabsByViewInstanceId[promotion.source.viewInstanceId];
    tabOrder = tabOrder.filter(
      (viewInstanceId) => viewInstanceId !== promotion.source.viewInstanceId,
    );
  }
  return {
    ...restoredHost,
    activeViewInstanceId: promotion.rollback.activeViewInstanceId,
    tabOrder,
    tabsByViewInstanceId,
    promotionsById: {
      ...restoredHost.promotionsById,
      [promotionId]: {
        id: promotion.id,
        organizationId,
        clientMutationId: promotion.clientMutationId,
        source: promotion.source,
        status: "claim_failed",
        savedViewId,
        error,
      },
    },
  };
}

function updateRuntimeTarget(
  organization: MainWorkbenchOrganizationState,
  runtimeId: string,
  viewInstanceId: string,
  target: MainWorkbenchTarget,
): MainWorkbenchOrganizationState {
  const runtime = organization.runtimesById[runtimeId];
  if (
    !runtime
    || runtime.viewInstanceId !== viewInstanceId
    || target.viewInstanceId !== viewInstanceId
    || runtime.targetKind !== target.kind
  ) {
    return organization;
  }
  return {
    ...organization,
    runtimesById: {
      ...organization.runtimesById,
      [runtimeId]: {
        ...runtime,
        target: cloneTarget(target),
      },
    },
  };
}

function updateTabTarget(
  organization: MainWorkbenchOrganizationState,
  runtimeId: string,
  viewInstanceId: string,
  target: MainWorkbenchTarget,
): MainWorkbenchOrganizationState {
  const tab = organization.tabsByViewInstanceId[viewInstanceId];
  const runtime = organization.runtimesById[runtimeId];
  if (
    !tab
    || tab.runtimeId !== runtimeId
    || tab.target.kind !== target.kind
    || target.viewInstanceId !== viewInstanceId
    || !runtime
    || runtime.viewInstanceId !== viewInstanceId
    || runtime.targetKind !== target.kind
  ) {
    return organization;
  }
  return {
    ...organization,
    tabsByViewInstanceId: {
      ...organization.tabsByViewInstanceId,
      [viewInstanceId]: {
        ...tab,
        target: cloneTarget(target),
      },
    },
  };
}

export function mainWorkbenchReducer(
  state: MainWorkbenchState,
  action: MainWorkbenchAction,
): MainWorkbenchState {
  switch (action.type) {
    case "saved-tab/open":
      return updateOrganization(state, action.organizationId, (organization) => (
        openTab(
          organization,
          action.organizationId,
          action.tab,
          action.savedViewId,
        ).organization
      ));
    case "session-tab/create":
      return updateOrganization(state, action.organizationId, (organization) => (
        openTab(
          organization,
          action.organizationId,
          action.tab,
          null,
        ).organization
      ));
    case "tab/focus":
      return updateOrganization(state, action.organizationId, (organization) => {
        if (
          organization.activeViewInstanceId === action.viewInstanceId
          || !organization.tabsByViewInstanceId[action.viewInstanceId]
        ) {
          return organization;
        }
        return {
          ...organization,
          activeViewInstanceId: action.viewInstanceId,
        };
      });
    case "tab/reorder":
      return updateOrganization(state, action.organizationId, (organization) => (
        reorderTab(organization, action.viewInstanceId, action.toIndex)
      ));
    case "tab/bind-saved-view":
      return updateOrganization(state, action.organizationId, (organization) => (
        bindSavedView(organization, action.viewInstanceId, action.savedViewId)
      ));
    case "tab/unbind-saved-view":
      return updateOrganization(state, action.organizationId, (organization) => (
        unbindSavedView(organization, action.viewInstanceId, action.savedViewId)
      ));
    case "tab/close":
      return updateOrganization(state, action.organizationId, (organization) => (
        closeTab(organization, action.organizationId, action.viewInstanceId)
      ));
    case "tab/update-target":
      return updateOrganization(state, action.organizationId, (organization) => (
        updateTabTarget(
          organization,
          action.runtimeId,
          action.viewInstanceId,
          action.target,
        )
      ));
    case "runtime/admit":
      return updateOrganization(state, action.organizationId, (organization) => (
        withRuntime(organization, action.organizationId, action.runtime)
      ));
    case "runtime/set-host":
      return updateOrganization(state, action.organizationId, (organization) => {
        const runtime = organization.runtimesById[action.runtimeId];
        if (!runtime) return organization;
        return withRuntime(organization, action.organizationId, {
          id: runtime.id,
          viewInstanceId: runtime.viewInstanceId,
          targetKind: runtime.targetKind,
          target: runtime.target,
          host: action.host,
        });
      });
    case "runtime/update-target":
      return updateOrganization(state, action.organizationId, (organization) => (
        updateRuntimeTarget(
          organization,
          action.runtimeId,
          action.viewInstanceId,
          action.target,
        )
      ));
    case "promotion/start":
      return updateOrganization(state, action.organizationId, (organization) => (
        startPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.source,
          action.clientMutationId,
        )
      ));
    case "promotion/server-commit":
      return updateOrganization(state, action.organizationId, (organization) => (
        serverCommitPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.savedViewId,
          action.expectedSourceRevision,
        )
      ));
    case "promotion/claim":
      return updateOrganization(state, action.organizationId, (organization) => (
        claimPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.savedViewId,
          action.expectedSourceRevision,
        )
      ));
    case "promotion/detach-succeed":
      return updateOrganization(state, action.organizationId, (organization) => (
        detachSucceedPromotion(
          organization,
          action.promotionId,
          action.savedViewId,
          action.expectedSourceRevision,
        )
      ));
    case "promotion/detach-fail":
      return updateOrganization(state, action.organizationId, (organization) => (
        detachFailPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.savedViewId,
          action.expectedSourceRevision,
          action.error,
        )
      ));
    case "promotion/server-fail":
      return updateOrganization(state, action.organizationId, (organization) => (
        serverFailPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.expectedSourceRevision,
          action.error,
        )
      ));
    case "promotion/timeout":
      return updateOrganization(state, action.organizationId, (organization) => (
        timeoutPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.expectedSourceRevision,
          action.error,
        )
      ));
    case "promotion/retry":
      return updateOrganization(state, action.organizationId, (organization) => (
        retryPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.expectedSourceRevision,
          action.nextSourceRevision,
        )
      ));
    case "promotion/reconcile":
      return updateOrganization(state, action.organizationId, (organization) => (
        reconcilePromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.expectedSourceRevision,
          action.nextSourceRevision,
        )
      ));
    case "promotion/claim-fail":
      return updateOrganization(state, action.organizationId, (organization) => (
        claimFailPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.savedViewId,
          action.expectedSourceRevision,
          action.error,
        )
      ));
    case "promotion/claim-retry":
      return updateOrganization(state, action.organizationId, (organization) => (
        retryPromotionClaim(
          organization,
          action.organizationId,
          action.promotionId,
          action.expectedSourceRevision,
          action.nextSourceRevision,
        )
      ));
    case "promotion/discard":
      return updateOrganization(state, action.organizationId, (organization) => (
        discardPromotion(
          organization,
          action.promotionId,
          action.expectedSourceRevision,
        )
      ));
    case "promotion/cancel-saved-view":
      return updateOrganization(state, action.organizationId, (organization) => (
        cancelSavedViewPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.savedViewId,
          action.expectedSourceRevision,
        )
      ));
  }
}

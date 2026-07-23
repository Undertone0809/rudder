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
  target: MainWorkbenchTarget;
  originContextKey: string;
  runtimeId: string;
};

type MainWorkbenchPendingPromotion = {
  id: string;
  organizationId: string;
  status: "pending";
  source: MainWorkbenchPromotionSourceSnapshot;
};

type MainWorkbenchFailedPromotion = {
  id: string;
  organizationId: string;
  status: "failed";
  source: MainWorkbenchPromotionSourceSnapshot;
  error: string;
};

type MainWorkbenchClaimFailedPromotion = {
  id: string;
  organizationId: string;
  status: "claim_failed";
  source: MainWorkbenchPromotionSourceSnapshot;
  savedViewId: string;
  error: string;
};

/**
 * Successful promotion has no residual attempt record: the resulting tab and
 * its `main` runtime host are the success state. Failures stay here for retry.
 */
export type MainWorkbenchPromotion =
  | MainWorkbenchPendingPromotion
  | MainWorkbenchFailedPromotion
  | MainWorkbenchClaimFailedPromotion;

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
      type: "promotion/start";
      organizationId: string;
      promotionId: string;
      source: MainWorkbenchPromotionSourceSnapshot;
    }
  | {
      type: "promotion/succeed";
      organizationId: string;
      promotionId: string;
      savedViewId: string;
    }
  | {
      type: "promotion/fail";
      organizationId: string;
      promotionId: string;
      error: string;
    }
  | {
      type: "promotion/claim-fail";
      organizationId: string;
      promotionId: string;
      savedViewId: string;
      error: string;
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

function runtimeCanUseHost(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  runtime: MainWorkbenchRuntimeDraft,
): boolean {
  if (
    !runtime.id
    || !runtime.viewInstanceId
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
  return !addsLiveBrowser
    || organizationLiveBrowserCount(organization) < MAIN_WORKBENCH_BROWSER_CAPACITY;
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

function openTab(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  tab: MainWorkbenchTabDraft,
  savedViewId: string | null,
): MainWorkbenchOrganizationState {
  if (!validTabDraft(tab) || (savedViewId !== null && !savedViewId)) return organization;

  const existingTab = organization.tabsByViewInstanceId[tab.viewInstanceId];
  if (existingTab) {
    const bindingMatches = savedViewId === null || existingTab.savedViewId === savedViewId;
    const activeMatches = organization.activeViewInstanceId === tab.viewInstanceId;
    if (bindingMatches && activeMatches) return organization;
    return {
      ...organization,
      activeViewInstanceId: tab.viewInstanceId,
      tabsByViewInstanceId: savedViewId === null || existingTab.savedViewId === savedViewId
        ? organization.tabsByViewInstanceId
        : {
            ...organization.tabsByViewInstanceId,
            [tab.viewInstanceId]: {
              ...existingTab,
              savedViewId,
            },
          },
    };
  }

  const runtime: MainWorkbenchRuntimeDraft = {
    id: tab.runtimeId,
    viewInstanceId: tab.viewInstanceId,
    targetKind: tab.target.kind,
    host: { kind: "main", organizationId },
  };
  if (!runtimeCanUseHost(organization, organizationId, runtime)) return organization;
  const withMainRuntime = withRuntime(organization, organizationId, runtime);
  return {
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
  if (!tab || !savedViewId || tab.savedViewId === savedViewId) return organization;
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

function startPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  source: MainWorkbenchPromotionSourceSnapshot,
): MainWorkbenchOrganizationState {
  if (
    !promotionId
    || !validTabDraft(source)
    || organization.promotionsById[promotionId]?.status === "pending"
    || Object.values(organization.promotionsById).some(
      (promotion) => (
        promotion.status === "pending"
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
    host: { kind: "transferring" },
  });
  return {
    ...withTransferringRuntime,
    promotionsById: {
      ...withTransferringRuntime.promotionsById,
      [promotionId]: {
        id: promotionId,
        organizationId,
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
    host: { kind: "side", contextKey: source.originContextKey },
  });
}

function failPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  error: string,
): MainWorkbenchOrganizationState {
  const promotion = organization.promotionsById[promotionId];
  if (!promotion || promotion.status !== "pending") return organization;
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
        ...promotion,
        status: "failed",
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
  error: string,
): MainWorkbenchOrganizationState {
  const promotion = organization.promotionsById[promotionId];
  if (!promotion || promotion.status !== "pending" || !savedViewId) return organization;
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
        ...promotion,
        status: "claim_failed",
        savedViewId,
        error,
      },
    },
  };
}

function succeedPromotion(
  organization: MainWorkbenchOrganizationState,
  organizationId: string,
  promotionId: string,
  savedViewId: string,
): MainWorkbenchOrganizationState {
  const promotion = organization.promotionsById[promotionId];
  if (!promotion || promotion.status !== "pending" || !savedViewId) return organization;
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
  if (opened === organization) return organization;
  const { [promotionId]: _completed, ...promotionsById } = opened.promotionsById;
  return {
    ...opened,
    promotionsById,
  };
}

export function mainWorkbenchReducer(
  state: MainWorkbenchState,
  action: MainWorkbenchAction,
): MainWorkbenchState {
  switch (action.type) {
    case "saved-tab/open":
      return updateOrganization(state, action.organizationId, (organization) => (
        openTab(organization, action.organizationId, action.tab, action.savedViewId)
      ));
    case "session-tab/create":
      return updateOrganization(state, action.organizationId, (organization) => (
        openTab(organization, action.organizationId, action.tab, null)
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
          host: action.host,
        });
      });
    case "promotion/start":
      return updateOrganization(state, action.organizationId, (organization) => (
        startPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.source,
        )
      ));
    case "promotion/succeed":
      return updateOrganization(state, action.organizationId, (organization) => (
        succeedPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.savedViewId,
        )
      ));
    case "promotion/fail":
      return updateOrganization(state, action.organizationId, (organization) => (
        failPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.error,
        )
      ));
    case "promotion/claim-fail":
      return updateOrganization(state, action.organizationId, (organization) => (
        claimFailPromotion(
          organization,
          action.organizationId,
          action.promotionId,
          action.savedViewId,
          action.error,
        )
      ));
  }
}

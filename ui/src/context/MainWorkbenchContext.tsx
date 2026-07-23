import { createBrowserSidePanelTarget } from "@/lib/browser-side-panel";
import { useOptionalLiveSurfaceRuntime } from "@/context/LiveSurfaceRuntimeContext";
import {
  createMainWorkbenchState,
  MAIN_WORKBENCH_BROWSER_CAPACITY,
  mainWorkbenchLiveBrowserCount,
  mainWorkbenchReducer,
  type MainWorkbenchAction,
  type MainWorkbenchOrganizationState,
  type MainWorkbenchRuntimeDraft,
  type MainWorkbenchRuntimeHost,
  type MainWorkbenchState,
  type MainWorkbenchTabDraft,
  type MainWorkbenchTarget,
} from "@/lib/main-workbench-state";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

const EMPTY_ORGANIZATION_STATE: MainWorkbenchOrganizationState = {
  activeViewInstanceId: null,
  tabOrder: [],
  tabsByViewInstanceId: {},
  runtimesById: {},
  promotionsById: {},
};

export type MainWorkbenchAdmission =
  | {
      admitted: true;
      reason: null;
      viewInstanceId: string;
    }
  | {
      admitted: false;
      reason: "browser_capacity" | "rejected";
      viewInstanceId: null;
    };

type MainWorkbenchContextValue = {
  createId: () => string;
  state: MainWorkbenchState;
  dispatch: (action: MainWorkbenchAction) => MainWorkbenchState;
  getState: () => MainWorkbenchState;
};

const MainWorkbenchContext = createContext<MainWorkbenchContextValue | null>(null);

function newViewInstanceId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizedWorkbenchTarget(
  target: SidePanelTarget,
  requestedViewInstanceId?: string,
): MainWorkbenchTarget | null {
  if (
    target.kind !== "automation"
    && target.kind !== "browser"
    && target.kind !== "library_directory"
    && target.kind !== "library_document"
    && target.kind !== "library_entry"
    && target.kind !== "library_file"
    && target.kind !== "local_app"
  ) {
    return null;
  }
  const viewInstanceId = requestedViewInstanceId
    ?? target.viewInstanceId
    ?? (target.kind === "browser" ? target.tabId : newViewInstanceId());
  return { ...target, viewInstanceId } as MainWorkbenchTarget;
}

export function createMainWorkbenchRuntimeId(
  organizationId: string,
  target: MainWorkbenchTarget,
) {
  return JSON.stringify([organizationId, target.kind, target.viewInstanceId]);
}

export function MainWorkbenchProvider({
  children,
  createId = newViewInstanceId,
  initialState,
}: {
  children: ReactNode;
  createId?: () => string;
  initialState?: MainWorkbenchState;
}) {
  const [state, setState] = useState<MainWorkbenchState>(
    () => initialState ?? createMainWorkbenchState(),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const dispatch = useCallback((action: MainWorkbenchAction) => {
    const next = mainWorkbenchReducer(stateRef.current, action);
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  const getState = useCallback(() => stateRef.current, []);
  const value = useMemo<MainWorkbenchContextValue>(
    () => ({ createId, dispatch, getState, state }),
    [createId, dispatch, getState, state],
  );

  return (
    <MainWorkbenchContext.Provider value={value}>
      {children}
    </MainWorkbenchContext.Provider>
  );
}

export function useMainWorkbench() {
  const value = useContext(MainWorkbenchContext);
  if (!value) {
    throw new Error("useMainWorkbench must be used inside MainWorkbenchProvider");
  }
  return value;
}

export function useOrganizationMainWorkbench(organizationId: string | null | undefined) {
  const {
    createId,
    dispatch,
    getState: getGlobalState,
    state,
  } = useMainWorkbench();
  const liveSurfaceRuntime = useOptionalLiveSurfaceRuntime();
  const normalizedOrganizationId = organizationId?.trim() ?? "";
  const organization = normalizedOrganizationId
    ? state.organizations[normalizedOrganizationId] ?? EMPTY_ORGANIZATION_STATE
    : EMPTY_ORGANIZATION_STATE;
  const getState = useCallback(
    () => (
      (normalizedOrganizationId
        ? getGlobalState().organizations[normalizedOrganizationId]
        : null)
      ?? EMPTY_ORGANIZATION_STATE
    ),
    [getGlobalState, normalizedOrganizationId],
  );
  const liveBrowserCount = useCallback(() => {
    const reducerState = getGlobalState();
    if (!liveSurfaceRuntime) {
      return mainWorkbenchLiveBrowserCount(
        reducerState,
        normalizedOrganizationId,
      );
    }
    const organizationState =
      reducerState.organizations[normalizedOrganizationId];
    const reducerOnlyCount = Object.values(
      organizationState?.runtimesById ?? {},
    ).filter((runtime) => (
      runtime.targetKind === "browser"
      && runtime.host.kind !== "crashed"
      && runtime.host.kind !== "disposed"
      && !liveSurfaceRuntime.hasSurface(runtime.id)
    )).length;
    return (
      liveSurfaceRuntime.getLiveBrowserCount(normalizedOrganizationId)
      + reducerOnlyCount
    );
  }, [
    getGlobalState,
    liveSurfaceRuntime,
    normalizedOrganizationId,
  ]);

  const createSessionTab = useCallback((tab: MainWorkbenchTabDraft): MainWorkbenchAdmission => {
    if (!normalizedOrganizationId) {
      return { admitted: false, reason: "rejected", viewInstanceId: null };
    }
    const atBrowserCapacity = tab.target.kind === "browser"
      && !liveSurfaceRuntime?.hasSurface(tab.runtimeId)
      && liveBrowserCount() >= MAIN_WORKBENCH_BROWSER_CAPACITY;
    if (atBrowserCapacity) {
      return { admitted: false, reason: "browser_capacity", viewInstanceId: null };
    }
    const next = dispatch({
      type: "session-tab/create",
      organizationId: normalizedOrganizationId,
      tab,
    });
    const admitted = Boolean(
      next.organizations[normalizedOrganizationId]?.tabsByViewInstanceId[tab.viewInstanceId],
    );
    return admitted
      ? { admitted: true, reason: null, viewInstanceId: tab.viewInstanceId }
      : { admitted: false, reason: "rejected", viewInstanceId: null };
  }, [
    dispatch,
    liveBrowserCount,
    liveSurfaceRuntime,
    normalizedOrganizationId,
  ]);

  const createSessionBrowser = useCallback((
    input?: Extract<SidePanelTarget, { kind: "browser" }>,
  ): MainWorkbenchAdmission => {
    const target = normalizedWorkbenchTarget(
      input ?? {
        ...createBrowserSidePanelTarget(),
        tabId: createId(),
      },
      input?.viewInstanceId ?? input?.tabId ?? createId(),
    );
    if (!target || target.kind !== "browser" || !normalizedOrganizationId) {
      return { admitted: false, reason: "rejected", viewInstanceId: null };
    }
    return createSessionTab({
      viewInstanceId: target.viewInstanceId,
      runtimeId: createMainWorkbenchRuntimeId(normalizedOrganizationId, target),
      target,
      originContextKey: "messenger:workbench",
    });
  }, [createId, createSessionTab, normalizedOrganizationId]);

  const openSavedTab = useCallback((
    savedViewId: string,
    tab: MainWorkbenchTabDraft,
  ): MainWorkbenchAdmission => {
    if (!normalizedOrganizationId || !savedViewId) {
      return { admitted: false, reason: "rejected", viewInstanceId: null };
    }
    const atBrowserCapacity = tab.target.kind === "browser"
      && !liveSurfaceRuntime?.hasSurface(tab.runtimeId)
      && liveBrowserCount() >= MAIN_WORKBENCH_BROWSER_CAPACITY;
    if (atBrowserCapacity) {
      return { admitted: false, reason: "browser_capacity", viewInstanceId: null };
    }
    const next = dispatch({
      type: "saved-tab/open",
      organizationId: normalizedOrganizationId,
      savedViewId,
      tab,
    });
    const admitted = Boolean(
      next.organizations[normalizedOrganizationId]?.tabsByViewInstanceId[tab.viewInstanceId],
    );
    return admitted
      ? { admitted: true, reason: null, viewInstanceId: tab.viewInstanceId }
      : { admitted: false, reason: "rejected", viewInstanceId: null };
  }, [
    dispatch,
    liveBrowserCount,
    liveSurfaceRuntime,
    normalizedOrganizationId,
  ]);

  const focusTab = useCallback((viewInstanceId: string) => {
    if (!normalizedOrganizationId) return;
    dispatch({
      type: "tab/focus",
      organizationId: normalizedOrganizationId,
      viewInstanceId,
    });
  }, [dispatch, normalizedOrganizationId]);

  const reorderTab = useCallback((viewInstanceId: string, toIndex: number) => {
    if (!normalizedOrganizationId) return;
    dispatch({
      type: "tab/reorder",
      organizationId: normalizedOrganizationId,
      viewInstanceId,
      toIndex,
    });
  }, [dispatch, normalizedOrganizationId]);

  const closeTab = useCallback((viewInstanceId: string) => {
    if (!normalizedOrganizationId) return;
    dispatch({
      type: "tab/close",
      organizationId: normalizedOrganizationId,
      viewInstanceId,
    });
  }, [dispatch, normalizedOrganizationId]);

  const bindSavedView = useCallback((viewInstanceId: string, savedViewId: string) => {
    if (!normalizedOrganizationId) return;
    dispatch({
      type: "tab/bind-saved-view",
      organizationId: normalizedOrganizationId,
      viewInstanceId,
      savedViewId,
    });
  }, [dispatch, normalizedOrganizationId]);

  const unbindSavedView = useCallback((viewInstanceId: string, savedViewId: string) => {
    if (!normalizedOrganizationId) return;
    dispatch({
      type: "tab/unbind-saved-view",
      organizationId: normalizedOrganizationId,
      viewInstanceId,
      savedViewId,
    });
  }, [dispatch, normalizedOrganizationId]);

  const updateTarget = useCallback((
    runtimeId: string,
    viewInstanceId: string,
    target: MainWorkbenchTarget,
  ) => {
    if (!normalizedOrganizationId) return;
    dispatch({
      type: "runtime/update-target",
      organizationId: normalizedOrganizationId,
      runtimeId,
      viewInstanceId,
      target,
    });
    dispatch({
      type: "tab/update-target",
      organizationId: normalizedOrganizationId,
      runtimeId,
      viewInstanceId,
      target,
    });
  }, [dispatch, normalizedOrganizationId]);

  const admitRuntime = useCallback((runtime: MainWorkbenchRuntimeDraft) => {
    if (!normalizedOrganizationId) return;
    dispatch({
      type: "runtime/admit",
      organizationId: normalizedOrganizationId,
      runtime,
    });
  }, [dispatch, normalizedOrganizationId]);

  const setRuntimeHost = useCallback((runtimeId: string, host: MainWorkbenchRuntimeHost) => {
    if (!normalizedOrganizationId) return;
    dispatch({
      type: "runtime/set-host",
      organizationId: normalizedOrganizationId,
      runtimeId,
      host,
    });
  }, [dispatch, normalizedOrganizationId]);

  const tabs = organization.tabOrder.flatMap((viewInstanceId) => {
    const tab = organization.tabsByViewInstanceId[viewInstanceId];
    return tab ? [tab] : [];
  });
  const activeTab = organization.activeViewInstanceId
    ? organization.tabsByViewInstanceId[organization.activeViewInstanceId] ?? null
    : null;

  return useMemo(() => ({
    activeTab,
    activeViewInstanceId: organization.activeViewInstanceId,
    admitRuntime,
    bindSavedView,
    canCreateBrowser:
      liveBrowserCount() < MAIN_WORKBENCH_BROWSER_CAPACITY,
    closeTab,
    createSessionBrowser,
    createSessionTab,
    dispatch,
    focusTab,
    getState,
    liveBrowserCount,
    openSavedTab,
    promotionsById: organization.promotionsById,
    reorderTab,
    runtimesById: organization.runtimesById,
    setRuntimeHost,
    tabOrder: organization.tabOrder,
    tabs,
    tabsByViewInstanceId: organization.tabsByViewInstanceId,
    unbindSavedView,
    updateTarget,
  }), [
    activeTab,
    admitRuntime,
    bindSavedView,
    closeTab,
    createSessionBrowser,
    createSessionTab,
    dispatch,
    focusTab,
    getState,
    normalizedOrganizationId,
    openSavedTab,
    organization.activeViewInstanceId,
    organization.promotionsById,
    organization.runtimesById,
    organization.tabOrder,
    organization.tabsByViewInstanceId,
    reorderTab,
    setRuntimeHost,
    state,
    tabs,
    unbindSavedView,
    updateTarget,
  ]);
}

export type OrganizationMainWorkbench = ReturnType<
  typeof useOrganizationMainWorkbench
>;

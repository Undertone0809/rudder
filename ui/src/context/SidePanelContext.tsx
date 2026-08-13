import { readDesktopShell } from "@/lib/desktop-shell";
import { getKeyboardShortcutPlatform } from "@/lib/keyboard-shortcuts";
import { applyOrganizationPrefix, extractOrganizationPrefixFromPath } from "@/lib/organization-routes";
import {
  sidePanelCanonicalTargetKey,
  sidePanelFullPageHref,
  sidePanelTargetKey,
  sidePanelTargetSupportsSavedView,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type SidePanelContextState = {
  activeKey: string | null;
  hasPanelState: boolean;
  open: boolean;
  tabs: SidePanelTarget[];
};

export type SidePanelOpenResult =
  | { admitted: true }
  | { admitted: false; reason: "browser_capacity" };

export type SidePanelOpenOptions = {
  allowNewBrowserGuest?: boolean;
};

export type DisplayedSidePanelContextHold = {
  organizationId: string;
  contextKey: string;
  reason?: "promotion" | "file_annotation";
};

export type SidePanelDetachResult =
  | {
    detached: true;
    revision: number;
    target: SidePanelTarget;
  }
  | {
    detached: false;
    reason: "not_found" | "revision_mismatch";
    revision: number | null;
  };

export type SidePanelBrowserResetDecision = "preserve" | "remove";
export type SidePanelBrowserResetHandler = (
  contextKey: string,
  target: Extract<SidePanelTarget, { kind: "browser" }>,
) => SidePanelBrowserResetDecision;

type SidePanelContextValue = {
  activeKey: string | null;
  open: boolean;
  tabs: SidePanelTarget[];
  contextKey: string;
  displayedContextHold: DisplayedSidePanelContextHold | null;
  clearCurrentContext: () => void;
  clearDisplayedContextHold: (reason?: DisplayedSidePanelContextHold["reason"]) => void;
  detachTargetForContext: (
    contextKey: string | null,
    exactKey: string,
    expectedRevision: number,
  ) => SidePanelDetachResult;
  getTargetRevisionForContext: (contextKey: string | null, exactKey: string) => number | null;
  hidePanel: () => void;
  holdDisplayedContext: (
    organizationId: string,
    contextKey?: string | null,
    reason?: DisplayedSidePanelContextHold["reason"],
  ) => boolean;
  openTarget: (target: SidePanelTarget, options?: SidePanelOpenOptions) => SidePanelOpenResult;
  openTargetInNewTab: (target: SidePanelTarget, options?: SidePanelOpenOptions) => SidePanelOpenResult;
  openTargetForContext: (
    contextKey: string | null,
    target: SidePanelTarget,
    options?: SidePanelOpenOptions,
  ) => SidePanelOpenResult;
  showPanel: () => void;
  showPanelForContext: (contextKey: string | null) => void;
  openEmpty: () => void;
  closePanel: () => void;
  closeTarget: (key: string) => void;
  registerCloseRequestHandler: (handler: (target: SidePanelTarget) => void | Promise<void>) => () => void;
  registerBrowserResetHandler: (handler: SidePanelBrowserResetHandler) => () => void;
  replaceTarget: (key: string, target: SidePanelTarget) => void;
  replaceTargetForContext: (contextKey: string | null, key: string, target: SidePanelTarget) => boolean;
  reorderTarget: (key: string, targetKey: string, position: "before" | "after") => void;
  setActiveKey: (key: string | null) => void;
  setContextKey: (contextKey: string | null) => void;
};

const SidePanelContext = createContext<SidePanelContextValue | null>(null);
const DEFAULT_SIDE_PANEL_CONTEXT_KEY = "global";
export const MAX_BROWSER_TABS_PER_CONTEXT = 8;

function normalizeContextKey(contextKey: string | null | undefined): string {
  return contextKey?.trim() || DEFAULT_SIDE_PANEL_CONTEXT_KEY;
}

function mobileSidePanelTargetHref(target: SidePanelTarget): string {
  const href = sidePanelFullPageHref(target);
  if (href) return href;
  if (target.kind === "issue_proposal") {
    return `/messenger/chat/${target.conversationId}?messageId=${encodeURIComponent(target.messageId)}`;
  }
  if (target.kind === "subagents") return `/messenger/chat/${target.conversationId}`;
  if (target.kind === "subagent") {
    return target.conversationId
      ? `/messenger/chat/${target.conversationId}${target.sourceMessageId ? `?messageId=${encodeURIComponent(target.sourceMessageId)}` : ""}`
      : "/messenger/chat";
  }
  if (target.kind === "goal_chat") return target.conversationId
    ? `/messenger/chat/${target.conversationId}`
    : `/goals/${target.goalId}`;
  if (target.kind === "local_file") return "/library";
  if (target.kind === "local_apps" || target.kind === "local_app") return "/apps";
  return "/messenger/chat";
}

function openSidePanelTargetOnMobile(target: SidePanelTarget): boolean {
  if (typeof window === "undefined" || window.innerWidth >= 768) return false;
  if (target.kind === "goal_chat") return false;
  const href = mobileSidePanelTargetHref(target);
  if (/^https?:\/\//i.test(href) && !href.startsWith(window.location.origin)) {
    window.location.assign(href);
    return true;
  }
  const organizationPrefix = extractOrganizationPrefixFromPath(window.location.pathname);
  const nextPath = applyOrganizationPrefix(href, organizationPrefix);
  window.history.pushState({}, "", nextPath);
  window.dispatchEvent(new PopStateEvent("popstate"));
  return true;
}

function emptyContextState(): SidePanelContextState {
  return { activeKey: null, hasPanelState: false, open: false, tabs: [] };
}

function contextHasPanelState(state: SidePanelContextState | undefined) {
  return Boolean(state && (state.hasPanelState || state.tabs.length > 0 || state.activeKey !== null));
}

function belongsToMainWorkbenchSurface(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(
    "[data-testid='messenger-main-workbench'],"
    + "[data-testid='live-surface-runtime-host'][data-owner-id^='main:']",
  ));
}

function newViewInstanceId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function targetWithViewInstance(
  tabs: SidePanelTarget[],
  target: SidePanelTarget,
  forceNew: boolean,
): SidePanelTarget {
  if (!sidePanelTargetSupportsSavedView(target)) return target;
  if (target.kind === "browser") {
    return { ...target, viewInstanceId: target.viewInstanceId ?? target.tabId };
  }
  if (!forceNew && target.viewInstanceId) return target;
  if (!forceNew) {
    const canonicalKey = sidePanelCanonicalTargetKey(target);
    const existing = tabs.find((candidate) => (
      sidePanelTargetSupportsSavedView(candidate)
      && sidePanelCanonicalTargetKey(candidate) === canonicalKey
    ));
    if (existing && existing.kind !== "browser" && "viewInstanceId" in existing && existing.viewInstanceId) {
      return { ...target, viewInstanceId: existing.viewInstanceId } as SidePanelTarget;
    }
  }
  return { ...target, viewInstanceId: newViewInstanceId() } as SidePanelTarget;
}

function browserTargetForPhysicalReuse(
  target: Extract<SidePanelTarget, { kind: "browser" }>,
  physicalTab: Extract<SidePanelTarget, { kind: "browser" }>,
) {
  return {
    ...target,
    tabId: physicalTab.tabId,
    viewInstanceId: physicalTab.viewInstanceId ?? physicalTab.tabId,
    savedViewRecovery: physicalTab.savedViewRecovery ?? target.savedViewRecovery,
  } satisfies Extract<SidePanelTarget, { kind: "browser" }>;
}

type SidePanelTargetUpsertResult = {
  activeKey: string | null;
  tabs: SidePanelTarget[];
  openResult: SidePanelOpenResult;
};

function upsertSidePanelTarget(
  tabs: SidePanelTarget[],
  activeKey: string | null,
  target: SidePanelTarget,
  allowNewBrowserGuest = true,
): SidePanelTargetUpsertResult {
  const nextKey = sidePanelTargetKey(target);
  const matchingBrowser = target.kind === "browser" && target.dedupeKey
    ? tabs.find((candidate) => candidate.kind === "browser" && candidate.dedupeKey === target.dedupeKey)
    : undefined;
  if (target.kind === "browser" && matchingBrowser?.kind === "browser") {
    const matchingKey = sidePanelTargetKey(matchingBrowser);
    const replacement = browserTargetForPhysicalReuse(target, matchingBrowser);
    return {
      activeKey: matchingKey,
      tabs: tabs.map((candidate) => (sidePanelTargetKey(candidate) === matchingKey ? replacement : candidate)),
      openResult: { admitted: true },
    };
  }
  const matchingTarget = tabs.find((candidate) => sidePanelTargetKey(candidate) === nextKey);
  if (matchingTarget) {
    const replacement = target.kind === "browser" && matchingTarget.kind === "browser"
      ? browserTargetForPhysicalReuse(target, matchingTarget)
      : target;
    return {
      activeKey: nextKey,
      tabs: tabs.map((candidate) => (sidePanelTargetKey(candidate) === nextKey ? replacement : candidate)),
      openResult: { admitted: true },
    };
  }
  const nextTabs = [...tabs, target];
  if (target.kind !== "browser") {
    return { activeKey: nextKey, tabs: nextTabs, openResult: { admitted: true } };
  }
  const browserTabCount = tabs.filter((candidate) => candidate.kind === "browser").length;
  if (
    allowNewBrowserGuest
    && browserTabCount < MAX_BROWSER_TABS_PER_CONTEXT
  ) {
    return { activeKey: nextKey, tabs: nextTabs, openResult: { admitted: true } };
  }

  return {
    activeKey,
    tabs,
    openResult: { admitted: false, reason: "browser_capacity" },
  };
}

function browserViewInstanceId(
  target: Extract<SidePanelTarget, { kind: "browser" }>,
) {
  return target.viewInstanceId?.trim() || target.tabId.trim();
}

function sidePanelBrowserInstances(
  states: Record<string, SidePanelContextState>,
) {
  const instances = new Set<string>();
  for (const state of Object.values(states)) {
    for (const target of state.tabs) {
      if (target.kind === "browser") {
        instances.add(browserViewInstanceId(target));
      }
    }
  }
  return instances;
}

function withoutBrowserTargets(
  state: SidePanelContextState,
  contextKey: string,
  resetHandler: SidePanelBrowserResetHandler | null,
): SidePanelContextState {
  const activeIndex = state.activeKey
    ? state.tabs.findIndex((target) => sidePanelTargetKey(target) === state.activeKey)
    : -1;
  const tabs = state.tabs.filter((target) => (
    target.kind !== "browser"
    || resetHandler?.(contextKey, target) === "preserve"
  ));
  if (tabs.length === state.tabs.length) return state;
  const activeStillExists = state.activeKey !== null
    && tabs.some((target) => sidePanelTargetKey(target) === state.activeKey);
  const fallback = tabs[Math.min(Math.max(activeIndex, 0), tabs.length - 1)] ?? tabs.at(-1) ?? null;
  return {
    ...state,
    activeKey: state.activeKey === null
      ? null
      : activeStillExists
        ? state.activeKey
        : fallback
          ? sidePanelTargetKey(fallback)
          : null,
    tabs,
  };
}

export function SidePanelProvider({ children }: { children: ReactNode }) {
  const contextStatesRef = useRef<Record<string, SidePanelContextState>>({
    [DEFAULT_SIDE_PANEL_CONTEXT_KEY]: emptyContextState(),
  });
  const targetRevisionsRef = useRef<Record<string, Record<string, number>>>({
    [DEFAULT_SIDE_PANEL_CONTEXT_KEY]: {},
  });
  const currentContextKeyRef = useRef(DEFAULT_SIDE_PANEL_CONTEXT_KEY);
  const [contextKey, setCurrentContextKey] = useState(DEFAULT_SIDE_PANEL_CONTEXT_KEY);
  const [currentContextState, setCurrentContextState] = useState<SidePanelContextState>(() => emptyContextState());
  const [displayedContextHold, setDisplayedContextHold] = useState<DisplayedSidePanelContextHold | null>(null);
  const [open, setOpen] = useState(false);
  const closeRequestHandlerRef = useRef<((target: SidePanelTarget) => void | Promise<void>) | null>(null);
  const browserResetHandlerRef = useRef<SidePanelBrowserResetHandler | null>(null);

  const writeContextState = useCallback((key: string, updater: (state: SidePanelContextState) => SidePanelContextState) => {
    const current = contextStatesRef.current[key] ?? emptyContextState();
    const next = updater(current);
    if (next !== current) {
      const currentTargets = new Map(
        current.tabs.map((target) => [sidePanelTargetKey(target), target] as const),
      );
      const currentRevisions = targetRevisionsRef.current[key] ?? {};
      const nextRevisions = { ...currentRevisions };
      for (const target of next.tabs) {
        const targetKey = sidePanelTargetKey(target);
        const previousTarget = currentTargets.get(targetKey);
        const previousRevision = currentRevisions[targetKey] ?? 0;
        nextRevisions[targetKey] = previousTarget
          ? previousTarget !== target
            ? previousRevision + 1
            : previousRevision
          : Object.hasOwn(currentRevisions, targetKey)
            ? previousRevision + 1
            : 0;
      }
      targetRevisionsRef.current = {
        ...targetRevisionsRef.current,
        [key]: nextRevisions,
      };
    }
    contextStatesRef.current = {
      ...contextStatesRef.current,
      [key]: next,
    };
    if (key === currentContextKeyRef.current) setCurrentContextState(next);
    return next;
  }, []);

  const setContextKey = useCallback((nextContextKey: string | null) => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    if (currentContextKeyRef.current === normalizedKey) return;
    const nextState = contextStatesRef.current[normalizedKey] ?? emptyContextState();
    currentContextKeyRef.current = normalizedKey;
    setCurrentContextState(nextState);
    setOpen(contextHasPanelState(nextState) && nextState.open);
    setCurrentContextKey((previousKey) => (previousKey === normalizedKey ? previousKey : normalizedKey));
  }, []);

  const openTarget = useCallback((
    target: SidePanelTarget,
    options?: SidePanelOpenOptions,
  ): SidePanelOpenResult => {
    if (openSidePanelTargetOnMobile(target)) return { admitted: true };
    let openResult: SidePanelOpenResult = { admitted: true };
    writeContextState(contextKey, (current) => {
      const sideBrowserInstances = sidePanelBrowserInstances(
        contextStatesRef.current,
      );
      const allowNewBrowserGuest = target.kind !== "browser"
        || sideBrowserInstances.has(browserViewInstanceId(target))
        || (
          options?.allowNewBrowserGuest !== false
          && sideBrowserInstances.size < MAX_BROWSER_TABS_PER_CONTEXT
        );
      const result = upsertSidePanelTarget(
        current.tabs,
        current.activeKey,
        targetWithViewInstance(current.tabs, target, false),
        allowNewBrowserGuest,
      );
      openResult = result.openResult;
      return {
        activeKey: result.activeKey,
        hasPanelState: true,
        open: true,
        tabs: result.tabs,
      };
    });
    setOpen(true);
    return openResult;
  }, [contextKey, writeContextState]);

  const openTargetInNewTab = useCallback((
    target: SidePanelTarget,
    options?: SidePanelOpenOptions,
  ): SidePanelOpenResult => {
    if (openSidePanelTargetOnMobile(target)) return { admitted: true };
    let openResult: SidePanelOpenResult = { admitted: true };
    writeContextState(contextKey, (current) => {
      const sideBrowserInstances = sidePanelBrowserInstances(
        contextStatesRef.current,
      );
      const allowNewBrowserGuest = target.kind !== "browser"
        || (
          options?.allowNewBrowserGuest !== false
          && sideBrowserInstances.size < MAX_BROWSER_TABS_PER_CONTEXT
        );
      const result = upsertSidePanelTarget(
        current.tabs,
        current.activeKey,
        targetWithViewInstance(current.tabs, target, true),
        allowNewBrowserGuest,
      );
      openResult = result.openResult;
      return {
        activeKey: result.activeKey,
        hasPanelState: true,
        open: true,
        tabs: result.tabs,
      };
    });
    setOpen(true);
    return openResult;
  }, [contextKey, writeContextState]);

  const openTargetForContext = useCallback((
    nextContextKey: string | null,
    target: SidePanelTarget,
    options?: SidePanelOpenOptions,
  ): SidePanelOpenResult => {
    if (openSidePanelTargetOnMobile(target)) return { admitted: true };
    const normalizedKey = normalizeContextKey(nextContextKey);
    let openResult: SidePanelOpenResult = { admitted: true };
    const nextState = writeContextState(normalizedKey, (current) => {
      const sideBrowserInstances = sidePanelBrowserInstances(
        contextStatesRef.current,
      );
      const allowNewBrowserGuest = target.kind !== "browser"
        || sideBrowserInstances.has(browserViewInstanceId(target))
        || (
          options?.allowNewBrowserGuest !== false
          && sideBrowserInstances.size < MAX_BROWSER_TABS_PER_CONTEXT
        );
      const result = upsertSidePanelTarget(
        current.tabs,
        current.activeKey,
        targetWithViewInstance(current.tabs, target, false),
        allowNewBrowserGuest,
      );
      openResult = result.openResult;
      return {
        activeKey: result.activeKey,
        hasPanelState: true,
        open: true,
        tabs: result.tabs,
      };
    });
    if (normalizedKey === currentContextKeyRef.current) {
      setCurrentContextState(nextState);
      setOpen(true);
    }
    return openResult;
  }, [writeContextState]);

  const showPanel = useCallback(() => {
    writeContextState(contextKey, (current) => ({ ...current, hasPanelState: true, open: true }));
    setOpen(true);
  }, [contextKey, writeContextState]);

  const showPanelForContext = useCallback((nextContextKey: string | null) => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const current = contextStatesRef.current[normalizedKey] ?? emptyContextState();
    const nextState = { ...current, hasPanelState: true, open: true };
    contextStatesRef.current = {
      ...contextStatesRef.current,
      [normalizedKey]: nextState,
    };
    currentContextKeyRef.current = normalizedKey;
    setCurrentContextKey(normalizedKey);
    setCurrentContextState(nextState);
    setOpen(true);
  }, []);

  const openEmpty = useCallback(() => {
    setOpen(true);
    writeContextState(contextKey, (current) => ({ ...current, activeKey: null, hasPanelState: true, open: true }));
  }, [contextKey, writeContextState]);

  const hidePanel = useCallback(() => {
    setDisplayedContextHold(null);
    writeContextState(contextKey, (current) => (
      contextHasPanelState(current)
        ? { ...current, open: false }
        : current
    ));
    setOpen(false);
  }, [contextKey, writeContextState]);

  const clearCurrentContext = useCallback(() => {
    setDisplayedContextHold(null);
    writeContextState(contextKey, () => emptyContextState());
    setOpen(false);
  }, [contextKey, writeContextState]);

  const closePanel = hidePanel;

  const clearDisplayedContextHold = useCallback((reason?: DisplayedSidePanelContextHold["reason"]) => {
    const normalizedReason = reason === "promotion" || reason === "file_annotation"
      ? reason
      : undefined;
    setDisplayedContextHold((current) => (
      normalizedReason && current?.reason !== normalizedReason ? current : null
    ));
  }, []);

  const holdDisplayedContext = useCallback((
    organizationId: string,
    nextContextKey: string | null = currentContextKeyRef.current,
    reason: DisplayedSidePanelContextHold["reason"] = "promotion",
  ) => {
    const normalizedOrganizationId = organizationId.trim();
    const normalizedContextKey = normalizeContextKey(nextContextKey);
    if (
      !normalizedOrganizationId
      || (!normalizedContextKey.startsWith("chat:") && !normalizedContextKey.startsWith("issue:"))
    ) {
      return false;
    }
    setDisplayedContextHold({
      organizationId: normalizedOrganizationId,
      contextKey: normalizedContextKey,
      reason,
    });
    return true;
  }, []);

  const getTargetRevisionForContext = useCallback((
    nextContextKey: string | null,
    exactKey: string,
  ) => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const targetExists = (contextStatesRef.current[normalizedKey]?.tabs ?? [])
      .some((target) => sidePanelTargetKey(target) === exactKey);
    if (!targetExists) return null;
    return targetRevisionsRef.current[normalizedKey]?.[exactKey] ?? 0;
  }, []);

  const detachTargetForContext = useCallback((
    nextContextKey: string | null,
    exactKey: string,
    expectedRevision: number,
  ): SidePanelDetachResult => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const current = contextStatesRef.current[normalizedKey] ?? emptyContextState();
    const detachingIndex = current.tabs.findIndex((candidate) => sidePanelTargetKey(candidate) === exactKey);
    if (detachingIndex < 0) {
      return { detached: false, reason: "not_found", revision: null };
    }
    const revision = targetRevisionsRef.current[normalizedKey]?.[exactKey] ?? 0;
    if (expectedRevision !== revision) {
      return { detached: false, reason: "revision_mismatch", revision };
    }
    const target = current.tabs[detachingIndex]!;
    const nextState = writeContextState(normalizedKey, (contextState) => {
      const nextTabs = contextState.tabs.filter((candidate) => sidePanelTargetKey(candidate) !== exactKey);
      if (nextTabs.length === 0) {
        return { activeKey: null, hasPanelState: true, open: false, tabs: [] };
      }
      if (contextState.activeKey !== exactKey) return { ...contextState, tabs: nextTabs };
      const fallbackTarget = nextTabs[Math.min(detachingIndex, nextTabs.length - 1)] ?? null;
      return {
        activeKey: fallbackTarget ? sidePanelTargetKey(fallbackTarget) : null,
        hasPanelState: true,
        open: true,
        tabs: nextTabs,
      };
    });
    if (normalizedKey === currentContextKeyRef.current) setOpen(nextState.open);
    return { detached: true, revision, target };
  }, [writeContextState]);

  const closeTarget = useCallback((key: string) => {
    writeContextState(contextKey, (current) => {
      const closingIndex = current.tabs.findIndex((candidate) => sidePanelTargetKey(candidate) === key);
      const nextTabs = current.tabs.filter((candidate) => sidePanelTargetKey(candidate) !== key);
      if (nextTabs.length === 0) {
        setOpen(false);
        return { activeKey: null, hasPanelState: true, open: false, tabs: [] };
      }
      if (current.activeKey !== key) return { ...current, tabs: nextTabs };
      const fallbackTarget = nextTabs[Math.min(Math.max(closingIndex, 0), nextTabs.length - 1)] ?? nextTabs.at(-1) ?? null;
      return { activeKey: fallbackTarget ? sidePanelTargetKey(fallbackTarget) : null, hasPanelState: true, open: true, tabs: nextTabs };
    });
  }, [contextKey, writeContextState]);

  const registerCloseRequestHandler = useCallback((handler: (target: SidePanelTarget) => void | Promise<void>) => {
    closeRequestHandlerRef.current = handler;
    return () => {
      if (closeRequestHandlerRef.current === handler) closeRequestHandlerRef.current = null;
    };
  }, []);

  const registerBrowserResetHandler = useCallback((
    handler: SidePanelBrowserResetHandler,
  ) => {
    browserResetHandlerRef.current = handler;
    return () => {
      if (browserResetHandlerRef.current === handler) {
        browserResetHandlerRef.current = null;
      }
    };
  }, []);

  const requestCloseTarget = useCallback((key: string) => {
    const current = contextStatesRef.current[currentContextKeyRef.current] ?? emptyContextState();
    const target = current.tabs.find((candidate) => sidePanelTargetKey(candidate) === key);
    if (!target) return;
    const handler = closeRequestHandlerRef.current;
    if (handler) {
      void handler(target);
      return;
    }
    closeTarget(key);
  }, [closeTarget]);

  const hasActiveClosableTab = open && Boolean(currentContextState.activeKey);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    const setSidePanelCloseShortcutActive =
      desktopShell?.setSidePanelCloseShortcutActive;
    if (!setSidePanelCloseShortcutActive) return undefined;
    let disposed = false;
    let lastActive: boolean | null = null;
    const syncShortcutOwner = () => {
      if (disposed) return;
      const nextActive = hasActiveClosableTab
        && !belongsToMainWorkbenchSurface(document.activeElement);
      if (lastActive === nextActive) return;
      lastActive = nextActive;
      void setSidePanelCloseShortcutActive(nextActive).catch(() => undefined);
    };
    const queueSync = () => queueMicrotask(syncShortcutOwner);
    document.addEventListener("focusin", queueSync, true);
    document.addEventListener("focusout", queueSync, true);
    syncShortcutOwner();
    return () => {
      disposed = true;
      document.removeEventListener("focusin", queueSync, true);
      document.removeEventListener("focusout", queueSync, true);
    };
  }, [hasActiveClosableTab]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    const setSidePanelCloseShortcutActive = desktopShell?.setSidePanelCloseShortcutActive;
    if (!setSidePanelCloseShortcutActive) return undefined;
    return () => {
      void setSidePanelCloseShortcutActive(false).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onBrowserReset) return undefined;
    return desktopShell.onBrowserReset(() => {
      const nextStates = Object.fromEntries(
        Object.entries(contextStatesRef.current).map(([key, state]) => [
          key,
          withoutBrowserTargets(
            state,
            key,
            browserResetHandlerRef.current,
          ),
        ]),
      );
      contextStatesRef.current = nextStates;
      const current = nextStates[currentContextKeyRef.current] ?? emptyContextState();
      setCurrentContextState(current);
      setOpen(contextHasPanelState(current) && current.open);
    });
  }, []);

  useEffect(() => {
    if (!hasActiveClosableTab) return undefined;
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onCloseSidePanelActiveTab) return undefined;
    return desktopShell.onCloseSidePanelActiveTab(() => {
      const activeKey = currentContextState.activeKey;
      if (activeKey) requestCloseTarget(activeKey);
    });
  }, [currentContextState.activeKey, hasActiveClosableTab, requestCloseTarget]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onOpenEmptySidePanel) return undefined;
    return desktopShell.onOpenEmptySidePanel(openEmpty);
  }, [openEmpty]);

  useEffect(() => {
    if (!open || !currentContextState.activeKey) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (belongsToMainWorkbenchSurface(event.target)) return;
      if (event.key.toLowerCase() !== "w") return;
      const platform = getKeyboardShortcutPlatform();
      if (platform === "mac" ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      requestCloseTarget(currentContextState.activeKey!);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [currentContextState.activeKey, open, requestCloseTarget]);

  const replaceTargetForContext = useCallback((
    nextContextKey: string | null,
    key: string,
    target: SidePanelTarget,
  ) => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const current = contextStatesRef.current[normalizedKey] ?? emptyContextState();
    if (!current.tabs.some((candidate) => sidePanelTargetKey(candidate) === key)) return false;
    const nextKey = sidePanelTargetKey(target);
    writeContextState(normalizedKey, (contextState) => ({
      ...contextState,
      activeKey: contextState.activeKey === key ? nextKey : contextState.activeKey,
      tabs: contextState.tabs.map((candidate) => (sidePanelTargetKey(candidate) === key ? target : candidate)),
    }));
    return true;
  }, [writeContextState]);

  const replaceTarget = useCallback((key: string, target: SidePanelTarget) => {
    replaceTargetForContext(contextKey, key, target);
  }, [contextKey, replaceTargetForContext]);

  const reorderTarget = useCallback((key: string, targetKey: string, position: "before" | "after") => {
    if (key === targetKey) return;
    writeContextState(contextKey, (current) => {
      const sourceIndex = current.tabs.findIndex((candidate) => sidePanelTargetKey(candidate) === key);
      const targetIndex = current.tabs.findIndex((candidate) => sidePanelTargetKey(candidate) === targetKey);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const nextTabs = [...current.tabs];
      const [source] = nextTabs.splice(sourceIndex, 1);
      if (!source) return current;
      const adjustedTargetIndex = nextTabs.findIndex((candidate) => sidePanelTargetKey(candidate) === targetKey);
      const insertionIndex = adjustedTargetIndex + (position === "after" ? 1 : 0);
      nextTabs.splice(insertionIndex, 0, source);
      return { ...current, tabs: nextTabs };
    });
  }, [contextKey, writeContextState]);

  const setActiveKey = useCallback((key: string | null) => {
    writeContextState(contextKey, (current) => ({ ...current, activeKey: key, hasPanelState: true, open: true }));
  }, [contextKey, writeContextState]);

  const value = useMemo<SidePanelContextValue>(() => ({
    activeKey: currentContextState.activeKey,
    clearCurrentContext,
    clearDisplayedContextHold,
    closePanel,
    closeTarget,
    contextKey,
    detachTargetForContext,
    displayedContextHold,
    getTargetRevisionForContext,
    hidePanel,
    holdDisplayedContext,
    open,
    openEmpty,
    openTarget,
    openTargetInNewTab,
    openTargetForContext,
    registerCloseRequestHandler,
    registerBrowserResetHandler,
    replaceTarget,
    replaceTargetForContext,
    reorderTarget,
    setActiveKey,
    setContextKey,
    showPanel,
    showPanelForContext,
    tabs: currentContextState.tabs,
  }), [clearCurrentContext, clearDisplayedContextHold, closePanel, closeTarget, contextKey, currentContextState.activeKey, currentContextState.tabs, detachTargetForContext, displayedContextHold, getTargetRevisionForContext, hidePanel, holdDisplayedContext, open, openEmpty, openTarget, openTargetForContext, openTargetInNewTab, registerBrowserResetHandler, registerCloseRequestHandler, reorderTarget, replaceTarget, replaceTargetForContext, setActiveKey, setContextKey, showPanel, showPanelForContext]);

  return <SidePanelContext.Provider value={value}>{children}</SidePanelContext.Provider>;
}

export function useSidePanel() {
  const value = useContext(SidePanelContext);
  if (!value) throw new Error("useSidePanel must be used inside SidePanelProvider");
  return value;
}

export function useOptionalSidePanel() {
  return useContext(SidePanelContext);
}

import { readDesktopShell } from "@/lib/desktop-shell";
import { getKeyboardShortcutPlatform } from "@/lib/keyboard-shortcuts";
import {
  sidePanelCanonicalTargetKey,
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

type SidePanelContextValue = {
  activeKey: string | null;
  open: boolean;
  tabs: SidePanelTarget[];
  contextKey: string;
  clearCurrentContext: () => void;
  hidePanel: () => void;
  openTarget: (target: SidePanelTarget) => void;
  openTargetInNewTab: (target: SidePanelTarget) => void;
  openTargetForContext: (contextKey: string | null, target: SidePanelTarget) => void;
  showPanel: () => void;
  showPanelForContext: (contextKey: string | null) => void;
  openEmpty: () => void;
  closePanel: () => void;
  closeTarget: (key: string) => void;
  registerCloseRequestHandler: (handler: (target: SidePanelTarget) => void | Promise<void>) => () => void;
  replaceTarget: (key: string, target: SidePanelTarget) => void;
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

function emptyContextState(): SidePanelContextState {
  return { activeKey: null, hasPanelState: false, open: false, tabs: [] };
}

function contextHasPanelState(state: SidePanelContextState | undefined) {
  return Boolean(state && (state.hasPanelState || state.tabs.length > 0 || state.activeKey !== null));
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

function upsertSidePanelTarget(
  tabs: SidePanelTarget[],
  activeKey: string | null,
  target: SidePanelTarget,
): { activeKey: string | null; tabs: SidePanelTarget[] } {
  const nextKey = sidePanelTargetKey(target);
  const matchingBrowser = target.kind === "browser" && target.dedupeKey
    ? tabs.find((candidate) => candidate.kind === "browser" && candidate.dedupeKey === target.dedupeKey)
    : undefined;
  if (matchingBrowser?.kind === "browser") {
    const matchingKey = sidePanelTargetKey(matchingBrowser);
    const replacement = { ...target, tabId: matchingBrowser.tabId };
    return {
      activeKey: matchingKey,
      tabs: tabs.map((candidate) => (sidePanelTargetKey(candidate) === matchingKey ? replacement : candidate)),
    };
  }
  if (tabs.some((candidate) => sidePanelTargetKey(candidate) === nextKey)) {
    return {
      activeKey: nextKey,
      tabs: tabs.map((candidate) => (sidePanelTargetKey(candidate) === nextKey ? target : candidate)),
    };
  }
  const nextTabs = [...tabs, target];
  if (target.kind !== "browser") return { activeKey: nextKey, tabs: nextTabs };
  const browserTabCount = tabs.filter((candidate) => candidate.kind === "browser").length;
  if (browserTabCount < MAX_BROWSER_TABS_PER_CONTEXT) return { activeKey: nextKey, tabs: nextTabs };

  // Ordinary Rudder links carry a URL dedupe key. At capacity, navigate an
  // existing Browser tab so the click still has a visible result.
  if (target.dedupeKey) {
    const activeBrowser = tabs.find((candidate) => (
      candidate.kind === "browser" && sidePanelTargetKey(candidate) === activeKey
    ));
    const reusable = activeBrowser ?? tabs.find((candidate) => candidate.kind === "browser");
    if (reusable?.kind === "browser") {
      const replacement = { ...target, tabId: reusable.tabId };
      const reusableKey = sidePanelTargetKey(reusable);
      return {
        activeKey: reusableKey,
        tabs: tabs.map((candidate) => (sidePanelTargetKey(candidate) === reusableKey ? replacement : candidate)),
      };
    }
  }
  return { activeKey, tabs };
}

function withoutBrowserTargets(state: SidePanelContextState): SidePanelContextState {
  const activeIndex = state.activeKey
    ? state.tabs.findIndex((target) => sidePanelTargetKey(target) === state.activeKey)
    : -1;
  const tabs = state.tabs.filter((target) => target.kind !== "browser");
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
  const currentContextKeyRef = useRef(DEFAULT_SIDE_PANEL_CONTEXT_KEY);
  const [contextKey, setCurrentContextKey] = useState(DEFAULT_SIDE_PANEL_CONTEXT_KEY);
  const [currentContextState, setCurrentContextState] = useState<SidePanelContextState>(() => emptyContextState());
  const [open, setOpen] = useState(false);
  const closeRequestHandlerRef = useRef<((target: SidePanelTarget) => void | Promise<void>) | null>(null);

  const writeContextState = useCallback((key: string, updater: (state: SidePanelContextState) => SidePanelContextState) => {
    const current = contextStatesRef.current[key] ?? emptyContextState();
    const next = updater(current);
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

  const openTarget = useCallback((target: SidePanelTarget) => {
    writeContextState(contextKey, (current) => {
      const result = upsertSidePanelTarget(
        current.tabs,
        current.activeKey,
        targetWithViewInstance(current.tabs, target, false),
      );
      return { ...result, hasPanelState: true, open: true };
    });
    setOpen(true);
  }, [contextKey, writeContextState]);

  const openTargetInNewTab = useCallback((target: SidePanelTarget) => {
    writeContextState(contextKey, (current) => {
      const result = upsertSidePanelTarget(
        current.tabs,
        current.activeKey,
        targetWithViewInstance(current.tabs, target, true),
      );
      return { ...result, hasPanelState: true, open: true };
    });
    setOpen(true);
  }, [contextKey, writeContextState]);

  const openTargetForContext = useCallback((nextContextKey: string | null, target: SidePanelTarget) => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const nextState = writeContextState(normalizedKey, (current) => {
      const result = upsertSidePanelTarget(
        current.tabs,
        current.activeKey,
        targetWithViewInstance(current.tabs, target, false),
      );
      return { ...result, hasPanelState: true, open: true };
    });
    if (normalizedKey === currentContextKeyRef.current) {
      setCurrentContextState(nextState);
      setOpen(true);
    }
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
    writeContextState(contextKey, (current) => (
      contextHasPanelState(current)
        ? { ...current, open: false }
        : current
    ));
    setOpen(false);
  }, [contextKey, writeContextState]);

  const clearCurrentContext = useCallback(() => {
    writeContextState(contextKey, () => emptyContextState());
    setOpen(false);
  }, [contextKey, writeContextState]);

  const closePanel = hidePanel;

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
    if (!desktopShell?.setSidePanelCloseShortcutActive) return;
    void desktopShell.setSidePanelCloseShortcutActive(hasActiveClosableTab).catch(() => undefined);
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
        Object.entries(contextStatesRef.current).map(([key, state]) => [key, withoutBrowserTargets(state)]),
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
    if (!open || !currentContextState.activeKey) return;
    const handleKeyDown = (event: KeyboardEvent) => {
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

  const replaceTarget = useCallback((key: string, target: SidePanelTarget) => {
    const nextKey = sidePanelTargetKey(target);
    writeContextState(contextKey, (current) => ({
      activeKey: current.activeKey === key ? nextKey : current.activeKey,
      hasPanelState: true,
      open: true,
      tabs: current.tabs.map((candidate) => (sidePanelTargetKey(candidate) === key ? target : candidate)),
    }));
  }, [contextKey, writeContextState]);

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
    closePanel,
    closeTarget,
    contextKey,
    hidePanel,
    open,
    openEmpty,
    openTarget,
    openTargetInNewTab,
    openTargetForContext,
    registerCloseRequestHandler,
    replaceTarget,
    reorderTarget,
    setActiveKey,
    setContextKey,
    showPanel,
    showPanelForContext,
    tabs: currentContextState.tabs,
  }), [clearCurrentContext, closePanel, closeTarget, contextKey, currentContextState.activeKey, currentContextState.tabs, hidePanel, open, openEmpty, openTarget, openTargetForContext, openTargetInNewTab, registerCloseRequestHandler, reorderTarget, replaceTarget, setActiveKey, setContextKey, showPanel, showPanelForContext]);

  return <SidePanelContext.Provider value={value}>{children}</SidePanelContext.Provider>;
}

export function useSidePanel() {
  const value = useContext(SidePanelContext);
  if (!value) throw new Error("useSidePanel must be used inside SidePanelProvider");
  return value;
}

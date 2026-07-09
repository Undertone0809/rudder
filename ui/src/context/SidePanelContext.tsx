import { readDesktopShell } from "@/lib/desktop-shell";
import { getKeyboardShortcutPlatform } from "@/lib/keyboard-shortcuts";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
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
  openTargetForContext: (contextKey: string | null, target: SidePanelTarget) => void;
  showPanel: () => void;
  showPanelForContext: (contextKey: string | null) => void;
  openEmpty: () => void;
  closePanel: () => void;
  closeTarget: (key: string) => void;
  replaceTarget: (key: string, target: SidePanelTarget) => void;
  setActiveKey: (key: string | null) => void;
  setContextKey: (contextKey: string | null) => void;
};

const SidePanelContext = createContext<SidePanelContextValue | null>(null);
const DEFAULT_SIDE_PANEL_CONTEXT_KEY = "global";

function normalizeContextKey(contextKey: string | null | undefined): string {
  return contextKey?.trim() || DEFAULT_SIDE_PANEL_CONTEXT_KEY;
}

function emptyContextState(): SidePanelContextState {
  return { activeKey: null, hasPanelState: false, open: false, tabs: [] };
}

function contextHasPanelState(state: SidePanelContextState | undefined) {
  return Boolean(state && (state.hasPanelState || state.tabs.length > 0 || state.activeKey !== null));
}

export function SidePanelProvider({ children }: { children: ReactNode }) {
  const contextStatesRef = useRef<Record<string, SidePanelContextState>>({
    [DEFAULT_SIDE_PANEL_CONTEXT_KEY]: emptyContextState(),
  });
  const currentContextKeyRef = useRef(DEFAULT_SIDE_PANEL_CONTEXT_KEY);
  const [contextKey, setCurrentContextKey] = useState(DEFAULT_SIDE_PANEL_CONTEXT_KEY);
  const [currentContextState, setCurrentContextState] = useState<SidePanelContextState>(() => emptyContextState());
  const [open, setOpen] = useState(false);

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
    const nextKey = sidePanelTargetKey(target);
    writeContextState(contextKey, (current) => {
      const tabs = current.tabs.some((candidate) => sidePanelTargetKey(candidate) === nextKey)
        ? current.tabs.map((candidate) => (sidePanelTargetKey(candidate) === nextKey ? target : candidate))
        : [...current.tabs, target];
      return { activeKey: nextKey, hasPanelState: true, open: true, tabs };
    });
    setOpen(true);
  }, [contextKey, writeContextState]);

  const openTargetForContext = useCallback((nextContextKey: string | null, target: SidePanelTarget) => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const nextKey = sidePanelTargetKey(target);
    const nextState = writeContextState(normalizedKey, (current) => {
      const tabs = current.tabs.some((candidate) => sidePanelTargetKey(candidate) === nextKey)
        ? current.tabs.map((candidate) => (sidePanelTargetKey(candidate) === nextKey ? target : candidate))
        : [...current.tabs, target];
      return { activeKey: nextKey, hasPanelState: true, open: true, tabs };
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
        setOpen(true);
        return { activeKey: null, hasPanelState: true, open: true, tabs: [] };
      }
      if (current.activeKey !== key) return { ...current, tabs: nextTabs };
      const fallbackTarget = nextTabs[Math.min(Math.max(closingIndex, 0), nextTabs.length - 1)] ?? nextTabs.at(-1) ?? null;
      return { activeKey: fallbackTarget ? sidePanelTargetKey(fallbackTarget) : null, hasPanelState: true, open: true, tabs: nextTabs };
    });
  }, [contextKey, writeContextState]);

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
    if (!hasActiveClosableTab) return undefined;
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onCloseSidePanelActiveTab) return undefined;
    return desktopShell.onCloseSidePanelActiveTab(() => {
      const activeKey = currentContextState.activeKey;
      if (activeKey) closeTarget(activeKey);
    });
  }, [closeTarget, currentContextState.activeKey, hasActiveClosableTab]);

  useEffect(() => {
    if (!open || !currentContextState.activeKey) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "w") return;
      const platform = getKeyboardShortcutPlatform();
      if (platform === "mac" ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      closeTarget(currentContextState.activeKey!);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [closeTarget, currentContextState.activeKey, open]);

  const replaceTarget = useCallback((key: string, target: SidePanelTarget) => {
    const nextKey = sidePanelTargetKey(target);
    writeContextState(contextKey, (current) => ({
      activeKey: current.activeKey === key ? nextKey : current.activeKey,
      hasPanelState: true,
      open: true,
      tabs: current.tabs.map((candidate) => (sidePanelTargetKey(candidate) === key ? target : candidate)),
    }));
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
    openTargetForContext,
    replaceTarget,
    setActiveKey,
    setContextKey,
    showPanel,
    showPanelForContext,
    tabs: currentContextState.tabs,
  }), [clearCurrentContext, closePanel, closeTarget, contextKey, currentContextState.activeKey, currentContextState.tabs, hidePanel, open, openEmpty, openTarget, openTargetForContext, replaceTarget, setActiveKey, setContextKey, showPanel, showPanelForContext]);

  return <SidePanelContext.Provider value={value}>{children}</SidePanelContext.Provider>;
}

export function useSidePanel() {
  const value = useContext(SidePanelContext);
  if (!value) throw new Error("useSidePanel must be used inside SidePanelProvider");
  return value;
}

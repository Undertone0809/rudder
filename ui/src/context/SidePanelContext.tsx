import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type SidePanelContextValue = {
  activeKey: string | null;
  open: boolean;
  tabs: SidePanelTarget[];
  openTarget: (target: SidePanelTarget) => void;
  openEmpty: () => void;
  toggleEmpty: () => void;
  closePanel: () => void;
  closeTarget: (key: string) => void;
  replaceTarget: (key: string, target: SidePanelTarget) => void;
  setActiveKey: (key: string | null) => void;
};

const SidePanelContext = createContext<SidePanelContextValue | null>(null);

export function SidePanelProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<SidePanelTarget[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const openTarget = useCallback((target: SidePanelTarget) => {
    const nextKey = sidePanelTargetKey(target);
    setTabs((current) => {
      if (current.some((candidate) => sidePanelTargetKey(candidate) === nextKey)) {
        return current.map((candidate) => (sidePanelTargetKey(candidate) === nextKey ? target : candidate));
      }
      return [...current, target];
    });
    setActiveKey(nextKey);
    setOpen(true);
  }, []);

  const openEmpty = useCallback(() => {
    setOpen(true);
    setActiveKey(null);
  }, []);

  const toggleEmpty = useCallback(() => {
    setOpen((current) => {
      if (current) {
        setActiveKey(null);
        setTabs([]);
        return false;
      }
      setActiveKey(null);
      return true;
    });
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
    setActiveKey(null);
    setTabs([]);
  }, []);

  const closeTarget = useCallback((key: string) => {
    setTabs((current) => {
      const closingIndex = current.findIndex((candidate) => sidePanelTargetKey(candidate) === key);
      const nextTabs = current.filter((candidate) => sidePanelTargetKey(candidate) !== key);
      if (nextTabs.length === 0) {
        setOpen(false);
        setActiveKey(null);
        return [];
      }
      setActiveKey((currentActiveKey) => {
        if (currentActiveKey !== key) return currentActiveKey;
        const fallbackTarget = nextTabs[Math.min(Math.max(closingIndex, 0), nextTabs.length - 1)] ?? nextTabs.at(-1) ?? null;
        return fallbackTarget ? sidePanelTargetKey(fallbackTarget) : null;
      });
      return nextTabs;
    });
  }, []);

  const replaceTarget = useCallback((key: string, target: SidePanelTarget) => {
    const nextKey = sidePanelTargetKey(target);
    setTabs((current) => current.map((candidate) => (sidePanelTargetKey(candidate) === key ? target : candidate)));
    setActiveKey((currentActiveKey) => (currentActiveKey === key ? nextKey : currentActiveKey));
  }, []);

  const value = useMemo<SidePanelContextValue>(() => ({
    activeKey,
    closePanel,
    closeTarget,
    open,
    openEmpty,
    openTarget,
    replaceTarget,
    setActiveKey,
    tabs,
    toggleEmpty,
  }), [activeKey, closePanel, closeTarget, open, openEmpty, openTarget, replaceTarget, tabs, toggleEmpty]);

  return <SidePanelContext.Provider value={value}>{children}</SidePanelContext.Provider>;
}

export function useSidePanel() {
  const value = useContext(SidePanelContext);
  if (!value) throw new Error("useSidePanel must be used inside SidePanelProvider");
  return value;
}

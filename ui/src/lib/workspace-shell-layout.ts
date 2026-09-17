import { useSidePanel } from "@/context/SidePanelContext";
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const SIDE_PANEL_WIDTH_KEY = "rudder.workspace.sidePanelWidth.v3";
export const SIDE_PANEL_DEFAULT_WIDTH = 420;
const SIDE_PANEL_MIN_WIDTH = 340;
const SIDE_PANEL_COLLAPSE_WIDTH = 292;
const SIDE_PANEL_COLLAPSE_GAP = SIDE_PANEL_MIN_WIDTH - SIDE_PANEL_COLLAPSE_WIDTH;
export const SIDE_PANEL_RESIZER_WIDTH = 4;
export const SIDE_PANEL_RESIZER_HIT_WIDTH = 10;

export function shouldAutoCollapseContextSidebar({
  isMobile,
  relativePath,
  sidePanelOpen,
  sidePanelContextReady,
}: {
  isMobile: boolean;
  relativePath: string;
  sidePanelOpen: boolean;
  sidePanelContextReady: boolean;
}): boolean {
  return !isMobile
    && sidePanelOpen
    && sidePanelContextReady
    && (/^\/agents\/[^/]+(?:\/|$)/.test(relativePath) || /^\/messenger(?:\/|$)/.test(relativePath));
}

function getSidePanelGeometry(workspaceWidth: number) {
  const availableWidth = Math.max(0, workspaceWidth - SIDE_PANEL_RESIZER_WIDTH);
  const twoToOneBoundary = availableWidth * (2 / 3);
  return {
    availableWidth,
    dockedMinWidth: Math.min(SIDE_PANEL_MIN_WIDTH, availableWidth / 2),
    dockedMaxWidth: twoToOneBoundary,
  };
}

export function clampSidePanelWidth(value: number, workspaceWidth: number | null = null): number {
  const roundedWidth = Math.round(value);
  if (workspaceWidth === null || !Number.isFinite(workspaceWidth)) {
    return Math.max(SIDE_PANEL_MIN_WIDTH, roundedWidth);
  }
  const geometry = getSidePanelGeometry(workspaceWidth);
  return Math.min(geometry.dockedMaxWidth, Math.max(geometry.dockedMinWidth, roundedWidth));
}

export function resolveProportionalSidePanelWidth(widthRatioValue: number, workspaceWidth: number): number {
  return clampSidePanelWidth(widthRatioValue * workspaceWidth, workspaceWidth);
}

export function resolveDefaultSidePanelWidth(workspaceWidth: number): number {
  return clampSidePanelWidth((workspaceWidth - SIDE_PANEL_RESIZER_WIDTH) / 2, workspaceWidth);
}

export function shouldAutoExpandSidePanel(panelWidth: number, workspaceWidth: number): boolean {
  const { availableWidth } = getSidePanelGeometry(workspaceWidth);
  const mainWidth = availableWidth - panelWidth;
  return panelWidth > 2 * mainWidth;
}

export function resolveSidePanelCollapseWidth(workspaceWidth: number | null): number {
  if (workspaceWidth === null || !Number.isFinite(workspaceWidth)) return SIDE_PANEL_COLLAPSE_WIDTH;
  const { dockedMinWidth } = getSidePanelGeometry(workspaceWidth);
  return Math.max(0, Math.min(SIDE_PANEL_COLLAPSE_WIDTH, dockedMinWidth - SIDE_PANEL_COLLAPSE_GAP));
}

export function resolveSidePanelDragWidth(
  startWidth: number,
  pointerDeltaX: number,
  renderedWorkspaceWidth: number,
  layoutWorkspaceWidth: number,
): number {
  const visualScale = Number.isFinite(renderedWorkspaceWidth)
    && Number.isFinite(layoutWorkspaceWidth)
    && renderedWorkspaceWidth > 0
    && layoutWorkspaceWidth > 0
    ? renderedWorkspaceWidth / layoutWorkspaceWidth
    : 1;
  return startWidth - pointerDeltaX / visualScale;
}

export function preserveRememberedSidePanelWidth(value: number): number {
  return Math.round(value);
}

export function readRememberedSidePanelWidth(): number {
  if (typeof window === "undefined") return SIDE_PANEL_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDE_PANEL_WIDTH_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed)) return SIDE_PANEL_DEFAULT_WIDTH;
    return preserveRememberedSidePanelWidth(parsed);
  } catch {
    return SIDE_PANEL_DEFAULT_WIDTH;
  }
}

export function useAutoCollapseWorkspaceWidth({
  autoCollapseContextSidebar,
  autoCollapseContextSidebarKey,
  autoCollapseContextSidebarOnOpen,
  contextColumnWidth,
  contextSidebarVisible,
  setWorkspaceWidth,
  workspaceAnchorRef,
  workspaceWidth,
}: {
  autoCollapseContextSidebar: boolean;
  autoCollapseContextSidebarKey: string | null;
  autoCollapseContextSidebarOnOpen: boolean;
  contextColumnWidth: number;
  contextSidebarVisible: boolean;
  setWorkspaceWidth: (width: number) => void;
  workspaceAnchorRef: RefObject<HTMLSpanElement | null>;
  workspaceWidth: number | null;
}): number | null {
  const sidePanel = useSidePanel();
  const autoCollapseWorkspaceWidthRef = useRef<{ key: string; width: number } | null>(null);

  const readWorkspaceMeasurements = useCallback(() => {
    const workspace = workspaceAnchorRef.current?.parentElement;
    const measuredWorkspaceWidth = workspace?.getBoundingClientRect().width ?? 0;
    const contextCard = document.querySelector<HTMLElement>("[data-testid='workspace-context-card']");
    const contextResizer = document.querySelector<HTMLElement>("[data-testid='workspace-column-resizer']");
    const contextCardWidth = contextCard?.getBoundingClientRect().width ?? 0;
    const contextResizerWidth = contextResizer?.getBoundingClientRect().width ?? 0;
    return {
      workspace,
      measuredWorkspaceWidth,
      contextCardWidth,
      contextResizerWidth,
    };
  }, [workspaceAnchorRef]);

  const captureWorkspaceWidthForPanelOpen = useCallback(() => {
    const {
      workspace,
      measuredWorkspaceWidth,
      contextCardWidth,
      contextResizerWidth,
    } = readWorkspaceMeasurements();
    if (!Number.isFinite(measuredWorkspaceWidth) || measuredWorkspaceWidth <= 0) return;

    setWorkspaceWidth(workspace?.offsetWidth ?? measuredWorkspaceWidth);
    if (!autoCollapseContextSidebarOnOpen || !autoCollapseContextSidebarKey) {
      autoCollapseWorkspaceWidthRef.current = null;
      return;
    }

    autoCollapseWorkspaceWidthRef.current = {
      key: autoCollapseContextSidebarKey,
      width: measuredWorkspaceWidth + (!contextSidebarVisible
        ? contextCardWidth + contextResizerWidth
        : Math.max(contextCardWidth, contextColumnWidth) + Math.max(contextResizerWidth, 9)),
    };
  }, [
    autoCollapseContextSidebarKey,
    autoCollapseContextSidebarOnOpen,
    contextColumnWidth,
    contextSidebarVisible,
    readWorkspaceMeasurements,
    setWorkspaceWidth,
  ]);

  useEffect(
    () => sidePanel.registerBeforeOpen(captureWorkspaceWidthForPanelOpen),
    [captureWorkspaceWidthForPanelOpen, sidePanel.registerBeforeOpen],
  );

  useLayoutEffect(() => {
    let frame: number | null = null;
    const updateWorkspaceMeasurements = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const {
          workspace,
          measuredWorkspaceWidth,
          contextCardWidth,
          contextResizerWidth,
        } = readWorkspaceMeasurements();
        if (!Number.isFinite(measuredWorkspaceWidth) || measuredWorkspaceWidth <= 0) return;

        setWorkspaceWidth(workspace?.offsetWidth ?? measuredWorkspaceWidth);
        if (!sidePanel.open || !autoCollapseContextSidebar || !autoCollapseContextSidebarKey) {
          autoCollapseWorkspaceWidthRef.current = null;
          return;
        }

        autoCollapseWorkspaceWidthRef.current = {
          key: autoCollapseContextSidebarKey,
          width: measuredWorkspaceWidth + contextCardWidth + contextResizerWidth,
        };
      });
    };

    updateWorkspaceMeasurements();
    const workspace = workspaceAnchorRef.current?.parentElement;
    if (typeof ResizeObserver === "undefined" || !workspace) {
      return () => {
        if (frame !== null) window.cancelAnimationFrame(frame);
      };
    }

    const observer = new ResizeObserver(updateWorkspaceMeasurements);
    observer.observe(workspace);
    const contextCard = document.querySelector<HTMLElement>("[data-testid='workspace-context-card']");
    const contextResizer = document.querySelector<HTMLElement>("[data-testid='workspace-column-resizer']");
    if (contextCard) observer.observe(contextCard);
    if (contextResizer) observer.observe(contextResizer);

    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [
    autoCollapseContextSidebar,
    autoCollapseContextSidebarKey,
    readWorkspaceMeasurements,
    setWorkspaceWidth,
    sidePanel.open,
    workspaceAnchorRef,
  ]);

  const capturedAutoCollapseWorkspaceWidth = autoCollapseContextSidebarKey
    && autoCollapseWorkspaceWidthRef.current?.key === autoCollapseContextSidebarKey
    ? autoCollapseWorkspaceWidthRef.current.width
    : null;
  return autoCollapseContextSidebar
    ? capturedAutoCollapseWorkspaceWidth ?? workspaceWidth
    : workspaceWidth;
}

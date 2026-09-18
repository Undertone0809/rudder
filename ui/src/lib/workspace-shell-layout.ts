import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const SIDE_PANEL_WIDTH_KEY = "rudder.workspace.sidePanelWidth.v3";
export const SIDE_PANEL_DEFAULT_WIDTH = 420;
const SIDE_PANEL_MIN_WIDTH = 340;
const SIDE_PANEL_COLLAPSE_WIDTH = 292;
const SIDE_PANEL_COLLAPSE_GAP = SIDE_PANEL_MIN_WIDTH - SIDE_PANEL_COLLAPSE_WIDTH;
export const SIDE_PANEL_RESIZER_WIDTH = 4;
export const SIDE_PANEL_RESIZER_HIT_WIDTH = 10;

export function getCurrentViewportWidth(): number | null {
  if (typeof window === "undefined") return null;
  return window.innerWidth;
}

export function widthRatio(value: number, widthBase: number | null = getCurrentViewportWidth()): number | null {
  if (widthBase === null || !Number.isFinite(widthBase) || widthBase <= 0) return null;
  return value / widthBase;
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

export function resolveProportionalSidePanelWidth(
  widthRatioValue: number,
  workspaceWidth: number,
): number {
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

type WorkspaceWidthSetter = (width: number | null) => void;

export function useSidePanelWorkspaceLayout({
  autoCollapseContextSidebar,
  autoCollapseContextSidebarKey,
  autoCollapseContextSidebarOnOpen,
  contextColumnWidth,
  contextSidebarVisible,
  registerBeforeOpen,
  sidePanelOpen,
  setWorkspaceWidth,
  workspaceAnchorRef,
  workspaceWidth,
}: {
  autoCollapseContextSidebar: boolean;
  autoCollapseContextSidebarKey: string | null;
  autoCollapseContextSidebarOnOpen: boolean;
  contextColumnWidth: number;
  contextSidebarVisible: boolean;
  registerBeforeOpen: (handler: () => void) => () => void;
  sidePanelOpen: boolean;
  setWorkspaceWidth: WorkspaceWidthSetter;
  workspaceAnchorRef: RefObject<HTMLElement | null>;
  workspaceWidth: number | null;
}): number | null {
  const autoCollapseWorkspaceWidthRef = useRef<{ key: string; width: number } | null>(null);

  const captureWorkspaceWidthForPanelOpen = useCallback(() => {
    const workspace = workspaceAnchorRef.current?.parentElement;
    const measuredWorkspaceWidth = workspace?.getBoundingClientRect().width ?? 0;
    if (!Number.isFinite(measuredWorkspaceWidth) || measuredWorkspaceWidth <= 0) return;

    setWorkspaceWidth(measuredWorkspaceWidth);
    if (!autoCollapseContextSidebarOnOpen || !autoCollapseContextSidebarKey) {
      autoCollapseWorkspaceWidthRef.current = null;
      return;
    }

    const contextCardWidth = document.querySelector<HTMLElement>("[data-testid='workspace-context-card']")?.getBoundingClientRect().width ?? 0;
    const contextResizerWidth = document.querySelector<HTMLElement>("[data-testid='workspace-column-resizer']")?.getBoundingClientRect().width ?? 0;
    autoCollapseWorkspaceWidthRef.current = {
      key: autoCollapseContextSidebarKey,
      width: measuredWorkspaceWidth + (!contextSidebarVisible
        ? 0
        : Math.max(contextCardWidth, contextColumnWidth) + Math.max(contextResizerWidth, 9)),
    };
  }, [
    autoCollapseContextSidebar,
    autoCollapseContextSidebarKey,
    autoCollapseContextSidebarOnOpen,
    contextColumnWidth,
    contextSidebarVisible,
    sidePanelOpen,
    setWorkspaceWidth,
    workspaceAnchorRef,
  ]);

  useEffect(
    () => registerBeforeOpen(captureWorkspaceWidthForPanelOpen),
    [captureWorkspaceWidthForPanelOpen, registerBeforeOpen],
  );

  useLayoutEffect(() => {
    if (!sidePanelOpen || !autoCollapseContextSidebar || !autoCollapseContextSidebarKey) {
      autoCollapseWorkspaceWidthRef.current = null;
      return;
    }
    if (autoCollapseWorkspaceWidthRef.current?.key === autoCollapseContextSidebarKey) return;

    const workspace = workspaceAnchorRef.current?.parentElement;
    const measuredWorkspaceWidth = workspace?.getBoundingClientRect().width ?? workspaceWidth ?? 0;
    if (!Number.isFinite(measuredWorkspaceWidth) || measuredWorkspaceWidth <= 0) return;

    autoCollapseWorkspaceWidthRef.current = {
      key: autoCollapseContextSidebarKey,
      width: measuredWorkspaceWidth,
    };
  }, [autoCollapseContextSidebar, autoCollapseContextSidebarKey, sidePanelOpen, workspaceWidth, workspaceAnchorRef]);

  useEffect(() => {
    if (!sidePanelOpen || !autoCollapseContextSidebar || !autoCollapseContextSidebarKey) return undefined;

    let frame: number | null = null;
    const handleResize = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const workspace = workspaceAnchorRef.current?.parentElement;
        const measuredWorkspaceWidth = workspace?.getBoundingClientRect().width ?? 0;
        if (!Number.isFinite(measuredWorkspaceWidth) || measuredWorkspaceWidth <= 0) return;
        autoCollapseWorkspaceWidthRef.current = {
          key: autoCollapseContextSidebarKey,
          width: measuredWorkspaceWidth,
        };
        setWorkspaceWidth(workspace?.offsetWidth ?? measuredWorkspaceWidth);
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [autoCollapseContextSidebar, autoCollapseContextSidebarKey, sidePanelOpen, setWorkspaceWidth, workspaceAnchorRef]);

  const capturedAutoCollapseWorkspaceWidth = autoCollapseContextSidebarKey
    && autoCollapseWorkspaceWidthRef.current?.key === autoCollapseContextSidebarKey
    ? autoCollapseWorkspaceWidthRef.current.width
    : null;
  return autoCollapseContextSidebar
    ? capturedAutoCollapseWorkspaceWidth ?? workspaceWidth
    : workspaceWidth;
}

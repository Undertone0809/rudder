import { useCallback, useEffect } from "react";
import { useSidePanel } from "@/context/SidePanelContext";
import { useSidebar } from "@/context/SidebarContext";
import {
  MESSENGER_THREE_PANEL_MIN_VIEWPORT_WIDTH,
  shouldAutoCollapseContextSidebar,
  shouldShowContextSidebar,
} from "@/lib/workspace-shell-layout";

export function useWorkspaceContextSidebarLayout({
  relativePath,
  contextKey,
  sidePanelOpen,
  sidePanelContextReady,
}: {
  relativePath: string;
  contextKey: string;
  sidePanelOpen: boolean;
  sidePanelContextReady: boolean;
}) {
  const {
    isMobile,
    viewportWidth,
    sidebarOpen,
    setSidebarOpen,
    contextSidebarExpandedByUser,
    setContextSidebarExpandedByUser,
    openSidebarByUser,
  } = useSidebar();
  const { hidePanel } = useSidePanel();
  const isMessengerRoute = /^\/messenger(?:\/|$)/.test(relativePath);
  const autoCollapseContextSidebar = shouldAutoCollapseContextSidebar({
    isMobile,
    relativePath,
    sidePanelOpen,
    sidePanelContextReady,
    viewportWidth,
  });
  const autoCollapseOnOpen = shouldAutoCollapseContextSidebar({
    isMobile,
    relativePath,
    sidePanelOpen: true,
    sidePanelContextReady,
    viewportWidth,
  });
  const contextSidebarVisible = shouldShowContextSidebar({
    sidebarOpen,
    autoCollapseContextSidebar,
    expandedByUser: contextSidebarExpandedByUser,
  });
  const openWorkspaceSidebar = useCallback(() => {
    if (autoCollapseContextSidebar && isMessengerRoute) {
      openSidebarByUser();
      return;
    }
    if (autoCollapseContextSidebar) hidePanel();
    setSidebarOpen(true);
  }, [autoCollapseContextSidebar, hidePanel, isMessengerRoute, openSidebarByUser, setSidebarOpen]);

  useEffect(() => {
    setContextSidebarExpandedByUser(false);
  }, [relativePath, setContextSidebarExpandedByUser, sidePanelOpen]);

  return {
    autoCollapseContextSidebar,
    autoCollapseContextSidebarOnOpen: autoCollapseOnOpen,
    autoCollapseContextSidebarKey: autoCollapseOnOpen ? `${relativePath}:${contextKey}` : null,
    contextSidebarVisible,
    openWorkspaceSidebar,
  };
}

export function useMessengerChatSidebarOpener({
  isMessengerChatRoute,
  sidePanelOpen,
}: {
  isMessengerChatRoute: boolean;
  sidePanelOpen: boolean;
}) {
  const {
    isMobile,
    sidebarOpen,
    contextSidebarExpandedByUser,
    openSidebarByUser,
    viewportWidth,
  } = useSidebar();
  const showChatSidebarOpener = !isMobile && (
    !sidebarOpen
    || (isMessengerChatRoute && sidePanelOpen
      && viewportWidth < MESSENGER_THREE_PANEL_MIN_VIEWPORT_WIDTH
      && !contextSidebarExpandedByUser)
  );

  return {
    isMobile,
    showChatSidebarOpener,
    openChatWorkspaceSidebar: openSidebarByUser,
  };
}

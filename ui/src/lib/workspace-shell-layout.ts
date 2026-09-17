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

import { useSidePanel } from "@/context/SidePanelContext";
import { useLayoutEffect } from "react";

export function SidePanelRouteContextBinder({
  contextKey,
  organizationId,
  preserveHold,
}: {
  contextKey: string;
  organizationId: string | null;
  preserveHold: boolean;
}) {
  const { clearDisplayedContextHold, setContextKey } = useSidePanel();

  useLayoutEffect(() => {
    if (!preserveHold) clearDisplayedContextHold();
    setContextKey(contextKey, organizationId);
  }, [clearDisplayedContextHold, contextKey, organizationId, preserveHold, setContextKey]);

  return null;
}

export function isSidePanelRouteContextReady({
  sidePanelContextKey,
  sidePanelOwnerOrganizationId,
  routeContextKey,
  routeOrganizationId,
}: {
  sidePanelContextKey: string;
  sidePanelOwnerOrganizationId: string | null;
  routeContextKey: string;
  routeOrganizationId: string | null | undefined;
}) {
  return sidePanelContextKey === routeContextKey
    && sidePanelOwnerOrganizationId === (routeOrganizationId ?? null);
}

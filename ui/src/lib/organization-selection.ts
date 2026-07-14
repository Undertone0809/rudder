export type OrganizationSelectionSource = "manual" | "route_sync" | "bootstrap";

export function shouldSyncOrganizationSelectionFromRoute(params: {
  selectionSource: OrganizationSelectionSource;
  selectedOrganizationId: string | null;
  routeOrganizationId: string;
}): boolean {
  const { selectionSource, selectedOrganizationId, routeOrganizationId } = params;

  if (selectedOrganizationId === routeOrganizationId) {
    return selectionSource !== "route_sync";
  }

  // Let manual organization switches finish their remembered-path navigation first.
  if (selectionSource === "manual" && selectedOrganizationId) {
    return false;
  }

  return true;
}

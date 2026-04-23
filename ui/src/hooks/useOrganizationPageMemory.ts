import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { useOrganization } from "../context/OrganizationContext";
import { toOrganizationRelativePath } from "../lib/organization-routes";
import {
  getRememberedPathOwnerOrganizationId,
  isRememberableOrganizationPath,
  sanitizeRememberedPathForOrganization,
} from "../lib/organization-page-memory";
import { readStoredSettingsOverlayBackgroundPath } from "@/lib/settings-overlay-state";

const STORAGE_KEY = "rudder.organizationPaths";

function getOrganizationPaths(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}

function saveOrganizationPath(orgId: string, path: string) {
  const paths = getOrganizationPaths();
  paths[orgId] = path;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
}

/**
 * Remembers the last visited page per organization and navigates to it on organization switch.
 * Falls back to /dashboard if no page was previously visited for a organization.
 */
export function useOrganizationPageMemory() {
  const { organizations, selectedOrganizationId, selectedOrganization, selectionSource } = useOrganization();
  const location = useLocation();
  const navigate = useNavigate();
  const prevOrganizationId = useRef<string | null>(selectedOrganizationId);
  const rememberedPathOwnerOrganizationId = useMemo(
    () =>
      getRememberedPathOwnerOrganizationId({
        organizations,
        pathname: location.pathname,
        fallbackOrganizationId: prevOrganizationId.current,
      }),
    [organizations, location.pathname],
  );

  // Save current path for current organization on every location change.
  // Uses prevOrganizationId ref so we save under the correct organization even
  // during the render where selectedOrganizationId has already changed.
  const fullPath = location.pathname + location.search;
  useEffect(() => {
    const orgId = rememberedPathOwnerOrganizationId;
    const relativePath = toOrganizationRelativePath(fullPath);
    if (orgId && isRememberableOrganizationPath(relativePath)) {
      saveOrganizationPath(orgId, relativePath);
    }
  }, [fullPath, rememberedPathOwnerOrganizationId]);

  // Navigate to saved path when organization changes
  useEffect(() => {
    if (!selectedOrganizationId) return;

    if (
      prevOrganizationId.current !== null &&
      selectedOrganizationId !== prevOrganizationId.current
    ) {
      const hasActiveSettingsOverlay = Boolean(readStoredSettingsOverlayBackgroundPath());
      if (!hasActiveSettingsOverlay && selectionSource !== "route_sync" && selectedOrganization) {
        const paths = getOrganizationPaths();
        const targetPath = sanitizeRememberedPathForOrganization({
          path: paths[selectedOrganizationId],
          organizationPrefix: selectedOrganization.issuePrefix,
        });
        navigate(`/${selectedOrganization.issuePrefix}${targetPath}`, { replace: true });
      }
    }
    prevOrganizationId.current = selectedOrganizationId;
  }, [selectedOrganization, selectedOrganizationId, selectionSource, navigate]);
}

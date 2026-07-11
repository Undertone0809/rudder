import { healthApi } from "@/api/health";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import {
  INSTANCE_SETTINGS_BROWSER_PATH,
  normalizeRememberedInstanceSettingsPath,
} from "@/lib/instance-settings";
import { queryKeys } from "@/lib/queryKeys";
import { Navigate, useLocation } from "@/lib/router";
import { preserveSettingsOverlayState } from "@/lib/settings-overlay-state";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

export function LocalTrustedSettingsRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  if (healthQuery.isLoading) return <SettingsPageSkeleton dense />;

  const target = normalizeRememberedInstanceSettingsPath(
    INSTANCE_SETTINGS_BROWSER_PATH,
    true,
    healthQuery.data?.deploymentMode ?? "authenticated",
  );
  if (target !== INSTANCE_SETTINGS_BROWSER_PATH) {
    const overlayState = preserveSettingsOverlayState(location.state);
    return <Navigate to={target} replace state={overlayState} />;
  }

  return children;
}

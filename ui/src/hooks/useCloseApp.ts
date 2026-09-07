import { messengerApi } from "@/api/messenger";
import { useOrganization } from "@/context/OrganizationContext";
import { useOptionalToast } from "@/context/ToastContext";
import { localAppIdentityMatches } from "@/lib/local-apps";
import { localAppSavedViewRoute } from "@/lib/messenger-saved-views";
import { closeApp, readOpenApps, type OpenApp } from "@/lib/open-apps";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

export function useCloseApp() {
  const { selectedOrganizationId } = useOrganization();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useOptionalToast();
  const queryClient = useQueryClient();
  const current = useRef({ organizationId: selectedOrganizationId, path: toOrganizationRelativePath(location.pathname) });
  current.current = { organizationId: selectedOrganizationId, path: toOrganizationRelativePath(location.pathname) };
  return useMutation({
    mutationFn: async ({ organizationId, app }: { organizationId: string; app: OpenApp }) => {
      let offset = 0;
      const pins = [];
      // Read all placements before mutating so pagination cannot skip a pin.
      for (;;) {
        const page = await messengerApi.listSavedViews(organizationId, { visibility: "visible", primaryRailPinned: true, limit: 100, offset });
        pins.push(...page.items.filter((saved) => saved.targetPayload.kind === "local_app" && (
          localAppSavedViewRoute(saved.id) === app.path
          || Boolean(app.identity && localAppIdentityMatches(app.identity, saved.targetPayload))
        )));
        if (!page.pageInfo.hasMore || page.pageInfo.nextOffset === null) break;
        offset = page.pageInfo.nextOffset;
      }
      await Promise.all(pins.map((saved) => messengerApi.updateSavedView(organizationId, saved.id, { primaryRailPinned: false })));
      return pins.map((saved) => localAppSavedViewRoute(saved.id));
    },
    onSuccess: async (pinnedPaths, { organizationId, app }) => {
      const matching = readOpenApps(organizationId).filter((entry) => entry.key === app.key || entry.path === app.path || Boolean(
        entry.identity && app.identity && localAppIdentityMatches(entry.identity, app.identity),
      ));
      const paths = [app.path, ...pinnedPaths, ...matching.map((entry) => entry.path)];
      if (current.current.organizationId === organizationId && paths.includes(current.current.path)) {
        navigate("/hub?tab=apps", { replace: true });
      }
      matching.forEach((entry) => closeApp(organizationId, entry.key));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messenger", organizationId, "saved-views"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.primaryRailPins(organizationId) }),
      ]);
    },
    onError: (error) => toast?.pushToast({ title: "Could not close App", body: error instanceof Error ? error.message : "Try again.", tone: "error" }),
  });
}

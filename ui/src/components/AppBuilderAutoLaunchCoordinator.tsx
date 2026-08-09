import { appBuilderApi } from "@/api/app-builder";
import { healthApi } from "@/api/health";
import { useOrganization } from "@/context/OrganizationContext";
import { useToast } from "@/context/ToastContext";
import { appRoute, requestAppDirectOpen } from "@/lib/apps-workspace";
import { launchManagedApp } from "@/lib/app-builder-launch";
import { readDesktopShell } from "@/lib/desktop-shell";
import { getOrganizationRouteKey } from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

export function AppBuilderAutoLaunchCoordinator() {
  const {
    organizations,
    selectedOrganizationId,
    setSelectedOrganizationId,
  } = useOrganization();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const inFlightAppId = useRef<string | null>(null);
  const selectedOrganizationIdRef = useRef(selectedOrganizationId);
  const [launchSequence, setLaunchSequence] = useState(0);
  selectedOrganizationIdRef.current = selectedOrganizationId;
  const desktopShell = readDesktopShell();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: Boolean(desktopShell?.appBuilder?.supported && desktopShell.localApps?.supported),
  });
  const enabled = Boolean(
    selectedOrganizationId
    && desktopShell?.appBuilder?.supported
    && desktopShell.localApps?.supported
    && healthQuery.data?.features?.experimentalSitesEnabled === true,
  );
  const appsQuery = useQuery({
    queryKey: queryKeys.appBuilder.organization(selectedOrganizationId ?? "__none__"),
    queryFn: () => appBuilderApi.list(selectedOrganizationId!),
    enabled,
    refetchInterval: (query) => {
      const apps = query.state.data ?? [];
      return apps.some((app) => (
        app.buildStatus === "preparing"
        || app.buildStatus === "building"
        || app.buildStatus === "verified_source_ready"
        || app.buildStatus === "verifying"
      )) ? 1_500 : false;
    },
  });

  useEffect(() => {
    if (!enabled || !desktopShell || !selectedOrganizationId || inFlightAppId.current) return;
    const app = appsQuery.data?.find((candidate) => (
      candidate.buildStatus === "verified_source_ready"
    ));
    if (!app) return;

    inFlightAppId.current = app.id;
    void launchManagedApp({
      app,
      desktopShell,
      expectedStatus: "verified_source_ready",
    }).then((binding) => {
      if (!binding) return;
      const key = `managed:${app.id}`;
      const openApp = () => {
        requestAppDirectOpen(app.orgId, key);
        const organization = organizations.find((candidate) => candidate.id === app.orgId);
        if (organization) {
          navigate(`/${getOrganizationRouteKey(organization)}${appRoute(key)}`);
          setSelectedOrganizationId(app.orgId, { source: "route_sync" });
          return;
        }
        navigate(appRoute(key));
      };
      const stillViewingLaunchOrganization = selectedOrganizationIdRef.current === app.orgId;
      if (stillViewingLaunchOrganization) openApp();
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.appBuilder.organization(app.orgId),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.localApps.definitions }),
      ]).catch(() => undefined);
      pushToast({
        title: `${app.name} is ready`,
        body: stillViewingLaunchOrganization
          ? "The App is open. Continue in Chat whenever you want to improve it."
          : "The App finished while you were working elsewhere.",
        tone: "success",
        action: stillViewingLaunchOrganization && app.conversationId
          ? {
              label: "Continue in Chat",
              onClick: () => navigate(`/messenger/chat/${app.conversationId}`),
            }
          : stillViewingLaunchOrganization
            ? undefined
            : { label: "Open App", onClick: openApp },
      });
    }).catch((error) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.appBuilder.organization(app.orgId),
      });
      pushToast({
        title: `${app.name} could not open`,
        body: error instanceof Error ? error.message : "Continue in Chat to diagnose the failure.",
        tone: "error",
        action: app.conversationId
          ? {
              label: "Continue in Chat",
              onClick: () => navigate(`/messenger/chat/${app.conversationId}`),
            }
          : undefined,
      });
    }).finally(() => {
      inFlightAppId.current = null;
      setLaunchSequence((current) => current + 1);
    });
  }, [
    appsQuery.data,
    desktopShell,
    enabled,
    launchSequence,
    navigate,
    organizations,
    pushToast,
    queryClient,
    selectedOrganizationId,
    setSelectedOrganizationId,
  ]);

  return null;
}

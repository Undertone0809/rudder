import { appBuilderApi } from "@/api/app-builder";
import { useOrganization } from "@/context/OrganizationContext";
import {
  type AppEntry,
  type LocalAppEntry,
  type ManagedAppEntry,
  localBindingKey,
} from "@/lib/apps-workspace";
import { readDesktopShell } from "@/lib/desktop-shell";
import { queryKeys } from "@/lib/queryKeys";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

export function useAppRegistry(enabled: boolean) {
  const { organizations, selectedOrganizationId } = useOrganization();
  const localApps = readDesktopShell()?.localApps;
  const appsQuery = useQuery({
    queryKey: queryKeys.appBuilder.organization(selectedOrganizationId ?? "__none__"),
    queryFn: () => appBuilderApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId && enabled),
  });
  const otherAppsQueries = useQueries({
    queries: organizations
      .filter((organization) => organization.id !== selectedOrganizationId)
      .map((organization) => ({
        queryKey: queryKeys.appBuilder.organization(organization.id),
        queryFn: () => appBuilderApi.list(organization.id),
        enabled,
      })),
  });
  const definitionsQuery = useQuery({
    queryKey: queryKeys.localApps.definitions,
    queryFn: () => localApps!.list(),
    enabled: Boolean(localApps?.supported && enabled),
  });
  const definitionByBinding = useMemo(
    () => new Map(
      (definitionsQuery.data ?? []).map((definition) => [
        localBindingKey(
          definition.desktopInstallationId,
          definition.appPublicId,
          definition.localBindingId,
        ),
        definition,
      ]),
    ),
    [definitionsQuery.data],
  );
  const managedEntries = useMemo<ManagedAppEntry[]>(() => (
    (appsQuery.data ?? []).map((app) => ({
      kind: "managed",
      key: `managed:${app.id}`,
      app,
      definition: app.desktopInstallationId && app.appPublicId && app.localBindingId
        ? definitionByBinding.get(localBindingKey(
            app.desktopInstallationId,
            app.appPublicId,
            app.localBindingId,
          )) ?? null
        : null,
    }))
  ), [appsQuery.data, definitionByBinding]);
  const reservedManagedBindings = useMemo(
    () => new Set(
      [
        ...(appsQuery.data ?? []),
        ...otherAppsQueries.flatMap((query) => query.data ?? []),
      ].flatMap((app) => (
        app.desktopInstallationId && app.appPublicId && app.localBindingId
          ? [localBindingKey(
              app.desktopInstallationId,
              app.appPublicId,
              app.localBindingId,
            )]
          : []
      )),
    ),
    [appsQuery.data, otherAppsQueries],
  );
  // Keep the last successful catalog visible while a live update refetches it.
  // Clearing entries during `isFetching` unmounts an active Local App webview.
  const managedCatalogReady = Boolean(
    enabled
    && appsQuery.data !== undefined
    && otherAppsQueries.every((query) => query.data !== undefined),
  );
  const registryReady = Boolean(
    managedCatalogReady
    && (
      !localApps?.supported
      || definitionsQuery.data !== undefined
    ),
  );
  const localEntries = useMemo<LocalAppEntry[]>(() => (
    managedCatalogReady
      ? (definitionsQuery.data ?? [])
        .filter((definition) => !reservedManagedBindings.has(localBindingKey(
          definition.desktopInstallationId,
          definition.appPublicId,
          definition.localBindingId,
        )))
        .map((definition) => ({
          kind: "local",
          key: `local:${definition.id}`,
          definition,
        }))
      : []
  ), [definitionsQuery.data, managedCatalogReady, reservedManagedBindings]);
  const entries = useMemo<AppEntry[]>(
    () => [...managedEntries, ...localEntries],
    [localEntries, managedEntries],
  );

  return { appsQuery, definitionsQuery, entries, localApps, registryReady };
}

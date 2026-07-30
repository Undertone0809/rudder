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
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

export function useAppRegistry(enabled: boolean) {
  const { selectedOrganizationId } = useOrganization();
  const localApps = readDesktopShell()?.localApps;
  const appsQuery = useQuery({
    queryKey: queryKeys.appBuilder.organization(selectedOrganizationId ?? "__none__"),
    queryFn: () => appBuilderApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId && enabled),
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
  const managedBindingIds = useMemo(
    () => new Set(
      managedEntries
        .map((entry) => entry.definition?.id)
        .filter((id): id is string => Boolean(id)),
    ),
    [managedEntries],
  );
  const localEntries = useMemo<LocalAppEntry[]>(() => (
    (definitionsQuery.data ?? [])
      .filter((definition) => !managedBindingIds.has(definition.id))
      .map((definition) => ({
        kind: "local",
        key: `local:${definition.id}`,
        definition,
      }))
  ), [definitionsQuery.data, managedBindingIds]);
  const entries = useMemo<AppEntry[]>(
    () => [...managedEntries, ...localEntries],
    [localEntries, managedEntries],
  );

  return { appsQuery, definitionsQuery, entries, localApps };
}

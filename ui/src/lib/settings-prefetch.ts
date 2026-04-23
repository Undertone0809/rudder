import type { QueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { chatsApi } from "@/api/chats";
import { healthApi } from "@/api/health";
import { heartbeatsApi } from "@/api/heartbeats";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { issuesApi } from "@/api/issues";
import { organizationsApi } from "@/api/orgs";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";

const SETTINGS_PREFETCH_STALE_TIME_MS = 60_000;

export function listSettingsPrefetchQueryKeys(target: string, organizationId: string | null): readonly unknown[][] {
  const keys: unknown[][] = [
    [...queryKeys.access.currentBoardAccess],
    [...queryKeys.organizations.all],
  ];

  if (target.startsWith("/organization/settings")) {
    if (organizationId) {
      keys.push(
        [...queryKeys.chats.list(organizationId, "archived")],
        [...queryKeys.issues.labels(organizationId)],
      );
    }
    return keys;
  }

  if (target.startsWith("/instance/settings/profile")) {
    keys.push([...queryKeys.instance.profileSettings]);
    return keys;
  }

  if (target.startsWith("/instance/settings/general")) {
    keys.push([...queryKeys.instance.generalSettings]);
    return keys;
  }

  if (target.startsWith("/instance/settings/notifications")) {
    keys.push([...queryKeys.instance.notificationSettings]);
    return keys;
  }

  if (target.startsWith("/instance/settings/organizations")) {
    keys.push([...queryKeys.organizations.stats]);
    return keys;
  }

  if (target.startsWith("/instance/settings/langfuse")) {
    keys.push([...queryKeys.instance.langfuseSettings]);
    return keys;
  }

  if (target.startsWith("/instance/settings/about")) {
    keys.push([...queryKeys.health]);
    return keys;
  }

  if (target.startsWith("/instance/settings/heartbeats")) {
    keys.push([...queryKeys.instance.schedulerHeartbeats]);
    return keys;
  }

  if (target.startsWith("/instance/settings/experimental")) {
    keys.push([...queryKeys.instance.experimentalSettings], [...queryKeys.health]);
    return keys;
  }

  if (target.startsWith("/instance/settings/plugins")) {
    keys.push([...queryKeys.plugins.all]);
    return keys;
  }

  return keys;
}

export function prefetchSettingsQueries(
  queryClient: QueryClient,
  {
    target,
    organizationId,
  }: {
    target: string;
    organizationId: string | null;
  },
) {
  const jobs = [
    queryClient.prefetchQuery({
      queryKey: queryKeys.access.currentBoardAccess,
      queryFn: () => accessApi.getCurrentBoardAccess(),
      staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.organizations.all,
      queryFn: () => organizationsApi.list(),
      staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
    }),
  ];

  if (target.startsWith("/organization/settings")) {
    if (organizationId) {
      jobs.push(
        queryClient.prefetchQuery({
          queryKey: queryKeys.chats.list(organizationId, "archived"),
          queryFn: () => chatsApi.list(organizationId, "archived"),
          staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
        }),
        queryClient.prefetchQuery({
          queryKey: queryKeys.issues.labels(organizationId),
          queryFn: () => issuesApi.listLabels(organizationId),
          staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
        }),
      );
    }
    return Promise.allSettled(jobs);
  }

  if (target.startsWith("/instance/settings/profile")) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: queryKeys.instance.profileSettings,
        queryFn: () => instanceSettingsApi.getProfile(),
        staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
      }),
    );
    return Promise.allSettled(jobs);
  }

  if (target.startsWith("/instance/settings/general")) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: queryKeys.instance.generalSettings,
        queryFn: () => instanceSettingsApi.getGeneral(),
        staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
      }),
    );
    return Promise.allSettled(jobs);
  }

  if (target.startsWith("/instance/settings/notifications")) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: queryKeys.instance.notificationSettings,
        queryFn: () => instanceSettingsApi.getNotifications(),
        staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
      }),
    );
    return Promise.allSettled(jobs);
  }

  if (target.startsWith("/instance/settings/organizations")) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: queryKeys.organizations.stats,
        queryFn: () => organizationsApi.stats(),
        staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
      }),
    );
    return Promise.allSettled(jobs);
  }

  if (target.startsWith("/instance/settings/langfuse")) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: queryKeys.instance.langfuseSettings,
        queryFn: () => instanceSettingsApi.getLangfuse(),
        staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
      }),
    );
    return Promise.allSettled(jobs);
  }

  if (target.startsWith("/instance/settings/about")) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: queryKeys.health,
        queryFn: () => healthApi.get(),
        staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
      }),
    );
    return Promise.allSettled(jobs);
  }

  if (target.startsWith("/instance/settings/heartbeats")) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: queryKeys.instance.schedulerHeartbeats,
        queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
        staleTime: 15_000,
      }),
    );
    return Promise.allSettled(jobs);
  }

  if (target.startsWith("/instance/settings/experimental")) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: queryKeys.instance.experimentalSettings,
        queryFn: () => instanceSettingsApi.getExperimental(),
        staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.health,
        queryFn: () => healthApi.get(),
        staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
      }),
    );
    return Promise.allSettled(jobs);
  }

  if (target.startsWith("/instance/settings/plugins")) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: queryKeys.plugins.all,
        queryFn: () => pluginsApi.list(),
        staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
      }),
    );
  }

  return Promise.allSettled(jobs);
}

export { SETTINGS_PREFETCH_STALE_TIME_MS };

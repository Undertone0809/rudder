import { messengerApi } from "@/api/messenger";
import {
  createBrowserSavedViewMetadataPersister,
  type BrowserSavedViewMetadata,
} from "@/lib/browser-saved-view-metadata";
import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

type BrowserTarget = Extract<SidePanelTarget, { kind: "browser" }>;

function instanceId(target: BrowserTarget) {
  return target.viewInstanceId ?? target.tabId;
}

function desiredMetadata(
  target: BrowserTarget,
  persistedMetadata: BrowserSavedViewMetadata,
): BrowserSavedViewMetadata {
  return {
    target: {
      kind: "browser",
      tabId: target.tabId,
      url: target.url,
      viewInstanceId: instanceId(target),
    },
    title: target.label,
    subtitle: target.url,
    favicon: target.favicon !== undefined
      ? target.favicon
      : persistedMetadata.target.url === target.url
        ? persistedMetadata.favicon
        : null,
  };
}

export function useBrowserSavedViewMetadataPersister({
  browserTargets,
  organizationId,
}: {
  browserTargets: BrowserTarget[];
  organizationId: string | null | undefined;
}) {
  const queryClient = useQueryClient();
  const persister = useMemo(() => createBrowserSavedViewMetadataPersister({
    update: async (orgId, savedViewId, metadata) => {
      await messengerApi.updateSavedView(orgId, savedViewId, metadata);
      void queryClient.invalidateQueries({ queryKey: queryKeys.messenger.customGroups(orgId) });
    },
  }), [queryClient]);
  const groupsQuery = useQuery({
    queryKey: queryKeys.messenger.customGroups(organizationId ?? "__none__"),
    queryFn: () => messengerApi.listCustomGroups(organizationId!),
    enabled: Boolean(organizationId && browserTargets.length > 0),
  });
  const groups = useMemo(
    () => groupsQuery.data && !Array.isArray(groupsQuery.data) ? groupsQuery.data.groups : [],
    [groupsQuery.data],
  );
  const savedEntries = useMemo(
    () => groups.flatMap((group) => group.entries).filter((entry) => entry.item.type === "saved_view"),
    [groups],
  );
  const instanceToSavedViewRef = useRef(new Map<string, {
    savedViewId: string;
    persistedMetadata: BrowserSavedViewMetadata;
  }>());

  useLayoutEffect(() => {
    if (!organizationId) return;
    const nextMapping = new Map<string, {
      savedViewId: string;
      persistedMetadata: BrowserSavedViewMetadata;
    }>();
    for (const target of browserTargets) {
      const targetInstanceId = instanceId(target);
      const entry = savedEntries.find((candidate) => (
        candidate.item.type === "saved_view"
        && candidate.item.savedView.targetPayload.kind === "browser"
        && candidate.item.savedView.targetPayload.viewInstanceId === targetInstanceId
      ));
      const savedView = entry?.item.type === "saved_view" ? entry.item.savedView : null;
      const entryMetadata: BrowserSavedViewMetadata | null = savedView?.targetPayload.kind === "browser"
        ? {
          target: savedView.targetPayload,
          title: savedView.title,
          subtitle: savedView.subtitle,
          favicon: savedView.favicon,
        }
        : null;
      const savedViewId = savedView?.targetPayload.kind === "browser"
        ? savedView.id
        : !groupsQuery.isSuccess
          ? target.savedViewRecovery?.id ?? null
          : null;
      const persistedMetadata = entryMetadata ?? (!groupsQuery.isSuccess
        ? target.savedViewRecovery?.persistedMetadata ?? null
        : null);
      if (!savedViewId || !persistedMetadata) continue;
      nextMapping.set(targetInstanceId, { savedViewId, persistedMetadata });
      persister.schedule({
        organizationId,
        savedViewId,
        metadata: desiredMetadata(target, persistedMetadata),
        persistedMetadata,
      });
    }

    for (const [previousInstanceId, previous] of instanceToSavedViewRef.current) {
      if (!nextMapping.has(previousInstanceId)) void persister.flushSavedView(previous.savedViewId);
    }
    instanceToSavedViewRef.current = nextMapping;
  }, [browserTargets, groupsQuery.isSuccess, organizationId, persister, savedEntries]);

  useEffect(() => () => {
    void persister.flushAll();
  }, [persister]);

  const flushTarget = useCallback((target: BrowserTarget) => {
    const directRecovery = target.savedViewRecovery;
    const mapped = instanceToSavedViewRef.current.get(instanceId(target));
    const recovered = mapped && (!groupsQuery.isSuccess || savedEntries.some((entry) => (
      entry.item.type === "saved_view" && entry.item.savedView.id === mapped.savedViewId
    )))
      ? mapped
      : !groupsQuery.isSuccess && directRecovery ? {
      savedViewId: directRecovery.id,
      persistedMetadata: directRecovery.persistedMetadata,
      } : null;
    if (!recovered || !organizationId) return Promise.resolve();
    persister.schedule({
      organizationId,
      savedViewId: recovered.savedViewId,
      metadata: desiredMetadata(target, recovered.persistedMetadata),
      persistedMetadata: recovered.persistedMetadata,
    });
    return persister.flushSavedView(recovered.savedViewId);
  }, [groupsQuery.isSuccess, organizationId, persister, savedEntries]);
  const flushAll = useCallback(() => persister.flushAll(), [persister]);

  return { flushAll, flushTarget };
}

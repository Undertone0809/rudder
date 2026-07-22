import { issuesApi } from "@/api/issues";
import { messengerApi } from "@/api/messenger";
import { useToast } from "@/context/ToastContext";
import {
  savedViewKeepInputFromSidePanelTarget,
  savedViewPlacementForSidePanelContext,
  type MessengerSavedViewKeepInput,
} from "@/lib/messenger-saved-views";
import { queryKeys } from "@/lib/queryKeys";
import {
  sidePanelTargetSupportsSavedView,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookmarkPlus, Check, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

function newMutationId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
}

const MAX_RETRYABLE_KEEP_INTENTS = 32;
const MAX_BROWSER_METADATA_FINGERPRINTS = 32;
const BROWSER_METADATA_DEBOUNCE_MS = 350;
const INTENT_KEY_PLACEHOLDER_MUTATION_ID = "00000000-0000-4000-8000-000000000000";

function stableIntentValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableIntentValue).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => (
      `${JSON.stringify(key)}:${stableIntentValue(entryValue)}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function keepIntentKey(input: MessengerSavedViewKeepInput) {
  const { clientMutationId: _clientMutationId, ...intent } = input;
  return stableIntentValue(intent);
}

function rememberBoundedFingerprint(cache: Map<string, string>, key: string, fingerprint: string) {
  cache.delete(key);
  cache.set(key, fingerprint);
  while (cache.size > MAX_BROWSER_METADATA_FINGERPRINTS) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function mutationIdForIntent(cache: Map<string, string>, intentKey: string) {
  const existing = cache.get(intentKey);
  if (existing) {
    cache.delete(intentKey);
    cache.set(intentKey, existing);
    return existing;
  }
  const mutationId = newMutationId();
  cache.set(intentKey, mutationId);
  while (cache.size > MAX_RETRYABLE_KEEP_INTENTS) {
    const oldestIntentKey = cache.keys().next().value;
    if (oldestIntentKey === undefined) break;
    cache.delete(oldestIntentKey);
  }
  return mutationId;
}

function retireCompletedIntent(cache: Map<string, string>, intentKey: string, mutationId: string) {
  if (cache.get(intentKey) === mutationId) cache.delete(intentKey);
}

export function KeepSidePanelViewButton({
  contextKey,
  organizationId,
  target,
}: {
  contextKey: string;
  organizationId: string | null | undefined;
  target: SidePanelTarget | null;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const mutationIdsRef = useRef(new Map<string, string>());
  const browserMetadataFingerprintsRef = useRef(new Map<string, string>());
  const browserMetadataQueuesRef = useRef(new Map<string, Promise<void>>());
  const eligible = Boolean(target && sidePanelTargetSupportsSavedView(target)
    && (target.kind !== "library_entry" || target.path));
  const hostIssueRef = contextKey.startsWith("issue:")
    ? contextKey.slice("issue:".length).trim() || null
    : null;
  const anchorPlacement = contextKey.startsWith("chat:") || Boolean(hostIssueRef);
  const hostIssueQuery = useQuery({
    queryKey: queryKeys.issues.detail(hostIssueRef ?? "__none__"),
    queryFn: () => issuesApi.get(hostIssueRef!),
    enabled: eligible && Boolean(hostIssueRef),
  });
  const groupsQuery = useQuery({
    queryKey: queryKeys.messenger.customGroups(organizationId ?? "__none__"),
    queryFn: () => messengerApi.listCustomGroups(organizationId!),
    enabled: eligible && Boolean(organizationId) && (!anchorPlacement || target?.kind === "browser"),
  });
  const groups = groupsQuery.data?.groups ?? [];
  const targetInstanceId = target && sidePanelTargetSupportsSavedView(target)
    ? target.kind === "browser"
      ? target.viewInstanceId ?? target.tabId
      : target.viewInstanceId ?? null
    : null;
  const existingSavedViewEntry = targetInstanceId && target && sidePanelTargetSupportsSavedView(target)
    ? groups.flatMap((group) => group.entries).find((entry) => (
      entry.item.type === "saved_view"
      && entry.item.savedView.targetPayload.kind === target.kind
      && entry.item.savedView.targetPayload.viewInstanceId === targetInstanceId
    )) ?? null
    : null;
  const existingSavedViewGroup = existingSavedViewEntry
    ? groups.find((group) => group.entries.some((entry) => entry.id === existingSavedViewEntry.id)) ?? null
    : null;

  useEffect(() => {
    if (!organizationId || target?.kind !== "browser" || existingSavedViewEntry?.item.type !== "saved_view") {
      return undefined;
    }
    const savedView = existingSavedViewEntry.item.savedView;
    if (savedView.targetPayload.kind !== "browser") return undefined;
    const desiredTarget = {
      kind: "browser" as const,
      tabId: target.tabId,
      url: target.url,
      viewInstanceId: target.viewInstanceId ?? target.tabId,
    };
    const desiredFavicon = target.favicon !== undefined
      ? target.favicon
      : savedView.targetPayload.url === target.url
        ? savedView.favicon
        : null;
    const metadata = {
      target: desiredTarget,
      title: target.label,
      subtitle: target.url,
      favicon: desiredFavicon,
    };
    const persistedMetadata = {
      target: savedView.targetPayload,
      title: savedView.title,
      subtitle: savedView.subtitle,
      favicon: savedView.favicon,
    };
    const fingerprint = stableIntentValue(metadata);
    if (fingerprint === stableIntentValue(persistedMetadata)
      || browserMetadataFingerprintsRef.current.get(savedView.id) === fingerprint) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      rememberBoundedFingerprint(browserMetadataFingerprintsRef.current, savedView.id, fingerprint);
      const previous = browserMetadataQueuesRef.current.get(savedView.id) ?? Promise.resolve();
      const queued = previous
        .catch(() => undefined)
        .then(async () => {
          await messengerApi.updateSavedView(organizationId, savedView.id, metadata);
          void queryClient.invalidateQueries({
            queryKey: queryKeys.messenger.customGroups(organizationId),
          });
        })
        .catch(() => {
          if (browserMetadataFingerprintsRef.current.get(savedView.id) === fingerprint) {
            browserMetadataFingerprintsRef.current.delete(savedView.id);
          }
        });
      browserMetadataQueuesRef.current.set(savedView.id, queued);
      void queued.finally(() => {
        if (browserMetadataQueuesRef.current.get(savedView.id) === queued) {
          browserMetadataQueuesRef.current.delete(savedView.id);
        }
      });
    }, BROWSER_METADATA_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [existingSavedViewEntry, organizationId, queryClient, target]);

  const keepMutation = useMutation({
    mutationFn: async (groupId: string | null) => {
      if (!organizationId || !target) throw new Error("Organization and Side Panel target are required");
      const placement = savedViewPlacementForSidePanelContext(
        contextKey,
        hostIssueQuery.data?.id ?? null,
        groupId,
      );
      if (!placement) {
        throw new Error(hostIssueRef
          ? "Wait for the Issue to finish loading, then try again."
          : "Choose a Messenger group first.");
      }
      const intent = savedViewKeepInputFromSidePanelTarget(target, {
        clientMutationId: INTENT_KEY_PLACEHOLDER_MUTATION_ID,
        placement,
      });
      if (!intent) throw new Error("This Side Panel view cannot be kept in Messenger.");
      const intentKey = keepIntentKey(intent);
      const clientMutationId = mutationIdForIntent(mutationIdsRef.current, intentKey);
      const result = await messengerApi.keepSavedView(organizationId, { ...intent, clientMutationId });
      return { clientMutationId, intentKey, result };
    },
    onSuccess: async ({ clientMutationId, intentKey, result }) => {
      retireCompletedIntent(mutationIdsRef.current, intentKey, clientMutationId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.customGroups(organizationId ?? "__none__") });
      pushToast({
        title: "Kept in Messenger",
        body: `Added to ${result.group.name}.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not keep this view",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
  });

  if (!eligible || !target) return null;
  const waitingForIssue = Boolean(hostIssueRef && hostIssueQuery.isPending);
  const buttonClass = "inline-flex h-7 items-center justify-center gap-1 rounded-[calc(var(--radius-sm)-1px)] px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
  const icon = keepMutation.isPending || waitingForIssue
    ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
    : keepMutation.isSuccess
      ? <Check className="h-3.5 w-3.5" aria-hidden />
      : <BookmarkPlus className="h-3.5 w-3.5" aria-hidden />;

  if (anchorPlacement) {
    if (hostIssueRef && hostIssueQuery.isError) {
      return (
        <div className="flex items-center gap-1 text-[11px]" role="alert">
          <span className="text-destructive">Could not load this Issue.</span>
          <button
            type="button"
            className={buttonClass}
            onClick={() => void hostIssueQuery.refetch()}
          >
            Retry Issue lookup
          </button>
        </div>
      );
    }
    return (
      <button
        type="button"
        data-testid="chat-side-panel-keep-in-messenger"
        aria-label="Keep in Messenger"
        title="Keep in Messenger"
        className={buttonClass}
        disabled={keepMutation.isPending || waitingForIssue || Boolean(hostIssueQuery.error)}
        onClick={() => keepMutation.mutate(null)}
      >
        {icon}
        <span className="hidden min-[1180px]:inline">Keep</span>
      </button>
    );
  }

  return (
    <DropdownMenu onOpenChange={(open) => {
      if (open) void groupsQuery.refetch();
    }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="chat-side-panel-keep-in-messenger"
          aria-label="Keep in Messenger"
          title="Keep in Messenger"
          className={buttonClass}
          disabled={keepMutation.isPending || groupsQuery.isPending || !organizationId}
        >
          {icon}
          <span className="hidden min-[1180px]:inline">Keep</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="surface-overlay w-64 text-foreground">
        <DropdownMenuLabel>Keep in Messenger group</DropdownMenuLabel>
        {groupsQuery.isError ? (
          <>
            <DropdownMenuItem disabled className="whitespace-normal text-xs leading-5">
              Could not load Messenger groups.
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void groupsQuery.refetch()}>
              Retry groups
            </DropdownMenuItem>
          </>
        ) : existingSavedViewGroup ? (
          <DropdownMenuItem disabled className="whitespace-normal text-xs leading-5">
            Already kept in {existingSavedViewGroup.name}. Use the Saved View row menu to move or remove it.
          </DropdownMenuItem>
        ) : groups.length > 0 ? groups.map((group) => (
          <DropdownMenuItem key={group.id} onClick={() => keepMutation.mutate(group.id)}>
            {group.name}
          </DropdownMenuItem>
        )) : (
          <DropdownMenuItem disabled className="whitespace-normal text-xs leading-5">
            No groups yet. Keep a view from a Chat or Issue first to create one.
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

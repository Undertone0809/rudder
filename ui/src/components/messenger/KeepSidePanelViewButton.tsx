import { issuesApi } from "@/api/issues";
import { messengerApi } from "@/api/messenger";
import { useToast } from "@/context/ToastContext";
import {
  savedViewKeepInputFromSidePanelTarget,
  savedViewPlacementForSidePanelContext,
} from "@/lib/messenger-saved-views";
import { queryKeys } from "@/lib/queryKeys";
import {
  sidePanelTargetKey,
  sidePanelTargetSupportsSavedView,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookmarkPlus, Check, Loader2 } from "lucide-react";
import { useRef } from "react";
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
    enabled: eligible && Boolean(organizationId) && !anchorPlacement,
  });
  const groups = groupsQuery.data?.groups ?? [];
  const targetInstanceId = target && sidePanelTargetSupportsSavedView(target)
    ? target.kind === "browser"
      ? target.viewInstanceId ?? target.tabId
      : target.viewInstanceId ?? null
    : null;
  const existingSavedViewGroup = targetInstanceId
    ? groups.find((group) => group.entries.some((entry) => (
      entry.item.type === "saved_view"
      && entry.item.savedView.targetPayload.viewInstanceId === targetInstanceId
    ))) ?? null
    : null;

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
      const targetKey = sidePanelTargetKey(target);
      let clientMutationId = mutationIdsRef.current.get(targetKey);
      if (!clientMutationId) {
        clientMutationId = newMutationId();
        mutationIdsRef.current.set(targetKey, clientMutationId);
      }
      const input = savedViewKeepInputFromSidePanelTarget(target, { clientMutationId, placement });
      if (!input) throw new Error("This Side Panel view cannot be kept in Messenger.");
      return messengerApi.keepSavedView(organizationId, input);
    },
    onSuccess: async (result) => {
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
        {existingSavedViewGroup ? (
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

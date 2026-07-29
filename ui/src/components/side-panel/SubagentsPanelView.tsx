import { chatsApi } from "@/api/chats";
import { getTranscriptAgentAvatarImageSrc } from "@/components/transcript/TranscriptAgentAvatarIcon";
import { useSidePanel } from "@/context/SidePanelContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import {
  collectChatSubagentInspections,
  type ChatWorkManifestSubagentSummary,
} from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";

type SubagentsTarget = Extract<SidePanelTarget, { kind: "subagents" }>;

function relativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function statusLabel(status: ChatWorkManifestSubagentSummary["status"]) {
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  if (status === "cancelled") return "Cancelled";
  if (status === "stopped") return "Stopped";
  return null;
}

function SubagentRow({
  item,
  loading,
  onOpen,
}: {
  item: ChatWorkManifestSubagentSummary;
  loading: boolean;
  onOpen(): void;
}) {
  const terminalLabel = statusLabel(item.status);
  return (
    <button
      type="button"
      className="group flex min-h-12 w-full min-w-0 items-center gap-3 rounded-[var(--radius-sm)] px-1.5 py-2 text-left transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      onClick={onOpen}
      title={item.label}
      data-testid={`chat-side-panel-subagent-row-${item.threadId}`}
    >
      <span className="relative inline-flex size-8 shrink-0">
        <img
          src={getTranscriptAgentAvatarImageSrc(item.avatarSeed)}
          alt=""
          className={cn(
            "size-8 rounded-full object-cover ring-1 ring-border/60",
            item.status === "failed" || item.status === "interrupted"
              ? "ring-destructive/50"
              : item.state === "active"
                ? "ring-cyan-500/45"
                : "ring-border/60",
          )}
        />
        {item.state === "active" ? (
          <span
            className="absolute -bottom-px -right-px size-2 rounded-full bg-cyan-500 ring-2 ring-background"
            aria-label="Active"
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{item.label}</span>
        {terminalLabel ? (
          <span className="block truncate text-[11px] leading-4 text-destructive">{terminalLabel}</span>
        ) : null}
      </span>
      {loading ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Loading subagent" />
      ) : (
        <time
          dateTime={item.updatedAt}
          title={new Date(item.updatedAt).toLocaleString()}
          className="shrink-0 text-xs tabular-nums text-muted-foreground"
        >
          {relativeTime(item.updatedAt)}
        </time>
      )}
    </button>
  );
}

function SubagentGroup({
  label,
  items,
  empty,
  loadingThreadId,
  onOpen,
}: {
  label: string;
  items: ChatWorkManifestSubagentSummary[];
  empty: string;
  loadingThreadId: string | null;
  onOpen(item: ChatWorkManifestSubagentSummary): void;
}) {
  return (
    <section aria-label={label}>
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {label} · {items.length}
      </div>
      {items.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-0.5" role="list">
          {items.map((item) => (
            <div key={item.threadId} role="listitem">
              <SubagentRow
                item={item}
                loading={loadingThreadId === item.threadId}
                onOpen={() => onOpen(item)}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function SubagentsPanelView({
  organizationId,
  target,
}: {
  organizationId: string;
  target: SubagentsTarget;
}) {
  const sidePanel = useSidePanel();
  const { pushToast } = useToast();
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const manifestQuery = useQuery({
    queryKey: queryKeys.chats.workManifest(organizationId, target.conversationId),
    queryFn: () => chatsApi.getWorkManifest(target.conversationId),
    refetchInterval: (query) => (
      (query.state.data?.subagents.active.length ?? 0) > 0 ? 2_000 : false
    ),
  });
  const subagents = manifestQuery.data?.subagents
    ?? { active: [], done: [], totalCount: 0 };

  const openSubagent = async (item: ChatWorkManifestSubagentSummary) => {
    if (loadingThreadId) return;
    setLoadingThreadId(item.threadId);
    try {
      const transcript = await chatsApi.getMessageTranscript(
        target.conversationId,
        item.sourceMessageId,
      );
      const inspection = collectChatSubagentInspections(transcript.transcript, {
        sourceMessageId: item.sourceMessageId,
        runId: item.runId,
        sourceActive: item.state === "active",
      }).find((candidate) => candidate.threadId === item.threadId);
      if (!inspection) throw new Error("The latest subagent evidence is not available.");
      sidePanel.openTarget({
        kind: "subagent",
        callId: inspection.callId,
        threadId: inspection.threadId,
        avatarSeed: inspection.avatarSeed,
        label: item.label,
        senderLabel: item.senderLabel ?? "Main agent",
        prompt: inspection.prompt,
        model: inspection.model,
        reasoningEffort: inspection.reasoningEffort,
        status: inspection.status,
        response: inspection.response,
        entries: inspection.entries,
        conversationId: target.conversationId,
        sourceMessageId: item.sourceMessageId,
      });
    } catch (error) {
      pushToast({
        title: "Failed to load subagent",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    } finally {
      setLoadingThreadId(null);
    }
  };

  if (manifestQuery.isPending) {
    return (
      <div className="grid h-full place-items-center" data-testid="chat-side-panel-subagents-view">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-label="Loading subagents" />
      </div>
    );
  }
  if (manifestQuery.isError) {
    return (
      <div className="p-4" data-testid="chat-side-panel-subagents-view">
        <div role="alert" className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
          {manifestQuery.error instanceof Error ? manifestQuery.error.message : "Could not load subagents."}
        </div>
      </div>
    );
  }

  return (
    <div
      className="scrollbar-auto-hide h-full min-h-0 overflow-y-auto px-4 py-4"
      data-testid="chat-side-panel-subagents-view"
    >
      <div className="space-y-8">
        <SubagentGroup
          label="Active"
          items={subagents.active}
          empty="No active subagents"
          loadingThreadId={loadingThreadId}
          onOpen={(item) => void openSubagent(item)}
        />
        <SubagentGroup
          label="Done"
          items={subagents.done}
          empty="No completed subagents"
          loadingThreadId={loadingThreadId}
          onOpen={(item) => void openSubagent(item)}
        />
      </div>
    </div>
  );
}

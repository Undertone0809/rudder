import { chatsApi } from "@/api/chats";
import { MarkdownBody } from "@/components/MarkdownBody";
import { RunTranscriptView } from "@/components/transcript/RunTranscriptView";
import { getTranscriptAgentAvatarImageSrc } from "@/components/transcript/TranscriptAgentAvatarIcon";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import { collectChatSubagentInspections } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";

type SubagentTarget = Extract<SidePanelTarget, { kind: "subagent" }>;

function statusKey(status: string) {
  return status
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function statusTone(status: string) {
  const normalized = statusKey(status);
  if (normalized === "failed" || normalized === "error") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (normalized === "running" || normalized === "in_progress") {
    return "border-cyan-500/25 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300";
  }
  return "border-border/60 bg-[color:var(--surface-active)] text-muted-foreground";
}

function statusLabel(status: string) {
  const normalized = statusKey(status).replace(/_/g, " ");
  return normalized
    ? normalized.charAt(0).toUpperCase() + normalized.slice(1)
    : "Unknown";
}

export function SubagentPanelView({ target }: { target: SubagentTarget }) {
  const manifestQuery = useQuery({
    queryKey: ["chat-subagent-live-manifest", target.conversationId, target.threadId],
    queryFn: () => chatsApi.getWorkManifest(target.conversationId!),
    enabled: Boolean(target.conversationId),
    refetchInterval: (query) => {
      const subagents = query.state.data?.subagents;
      const summary = [...(subagents?.active ?? []), ...(subagents?.done ?? [])]
        .find((candidate) => candidate.threadId === target.threadId);
      return summary?.state === "active" ? 2_000 : false;
    },
  });
  const liveSummary = [
    ...(manifestQuery.data?.subagents.active ?? []),
    ...(manifestQuery.data?.subagents.done ?? []),
  ].find((candidate) => candidate.threadId === target.threadId);
  const liveSourceMessageId = liveSummary?.sourceMessageId ?? target.sourceMessageId;
  const transcriptQuery = useQuery({
    queryKey: [
      "chat-subagent-live-transcript",
      target.conversationId,
      liveSourceMessageId,
      target.threadId,
      liveSummary?.status,
      liveSummary?.updatedAt,
    ],
    queryFn: () => chatsApi.getMessageTranscript(target.conversationId!, liveSourceMessageId!),
    enabled: Boolean(target.conversationId && liveSourceMessageId),
    refetchInterval: liveSummary?.state === "active" ? 2_000 : false,
  });
  const liveInspection = transcriptQuery.data
    ? collectChatSubagentInspections(transcriptQuery.data.transcript, {
      sourceMessageId: transcriptQuery.data.messageId,
      runId: liveSummary?.runId ?? null,
      sourceActive: liveSummary?.state === "active",
      senderLabel: liveSummary?.senderLabel,
    }).find((candidate) => candidate.threadId === target.threadId)
    : null;
  const displayTarget: SubagentTarget = {
    ...target,
    senderLabel: liveSummary?.senderLabel ?? target.senderLabel,
    status: liveSummary?.status ?? liveInspection?.status ?? target.status,
    response: liveInspection?.response ?? target.response,
    entries: liveInspection?.entries ?? target.entries,
    sourceMessageId: liveSummary?.sourceMessageId ?? target.sourceMessageId,
  };
  const response = displayTarget.response
    ?? [...displayTarget.entries].reverse().find((entry) => entry.kind === "assistant")?.text
    ?? null;
  const running = liveSummary?.state === "active"
    || ["running", "in_progress", "pending", "queued", "started"].includes(statusKey(displayTarget.status));

  return (
    <div
      className="scrollbar-auto-hide h-full min-h-0 overflow-y-auto"
      data-testid="chat-side-panel-subagent-view"
      data-subagent-thread-id={displayTarget.threadId}
    >
      <div className="border-b border-border/45 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <img
            src={getTranscriptAgentAvatarImageSrc(displayTarget.avatarSeed)}
            alt=""
            className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-border/60"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">{displayTarget.label}</div>
            <div className="truncate text-xs text-muted-foreground" title={displayTarget.threadId}>
              {displayTarget.threadId}
            </div>
          </div>
          <span className={cn("rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px]", statusTone(displayTarget.status))}>
            {statusLabel(displayTarget.status)}
          </span>
        </div>
        {displayTarget.model || displayTarget.reasoningEffort ? (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-[2.625rem] text-[11px] text-muted-foreground">
            {displayTarget.model ? <span>{displayTarget.model}</span> : null}
            {displayTarget.reasoningEffort ? <span>{displayTarget.reasoningEffort} reasoning</span> : null}
            <span>Read only</span>
          </div>
        ) : (
          <div className="mt-2 pl-[2.625rem] text-[11px] text-muted-foreground">Read only</div>
        )}
      </div>

      <div className="space-y-5 px-4 py-4">
        <section aria-label="Main agent message">
          <div className="mb-1.5 text-right text-xs font-medium text-muted-foreground">
            {displayTarget.senderLabel}
          </div>
          <div className="ml-auto w-fit max-w-[88%] rounded-[var(--radius-xl)] bg-[color:var(--surface-active)] px-3.5 py-2.5 text-sm leading-6 text-foreground shadow-[var(--shadow-sm)]">
            <MarkdownBody copyMarkdownOnCopy>{displayTarget.prompt}</MarkdownBody>
          </div>
        </section>

        {displayTarget.entries.length > 0 ? (
          <section aria-label="Sub-agent process">
            <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="h-px flex-1 bg-border/45" aria-hidden />
              <span>{running ? "Working" : "Process"}</span>
              <span className="h-px flex-1 bg-border/45" aria-hidden />
            </div>
            <RunTranscriptView
              entries={displayTarget.entries}
              mode="nice"
              density="compact"
              streaming={running}
              collapseStdout
              presentation="chat"
              hiddenAssistantMessageText={response}
            />
          </section>
        ) : null}

        <section aria-label="Sub-agent response">
          <div className="mb-2 flex items-center gap-2">
            <img
              src={getTranscriptAgentAvatarImageSrc(displayTarget.avatarSeed)}
              alt=""
              className="h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-border/60"
            />
            <span className="text-xs font-semibold text-foreground">{displayTarget.label}</span>
          </div>
          {response ? (
            <div className="max-w-[72ch] text-sm leading-6 text-foreground">
              <MarkdownBody copyMarkdownOnCopy enableCodeBlockCopy>{response}</MarkdownBody>
            </div>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              {running ? "The sub-agent is still working." : "No response was captured for this sub-agent."}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

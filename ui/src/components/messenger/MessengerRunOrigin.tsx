import { CopyText } from "@/components/CopyText";
import { StatusBadge } from "@/components/StatusBadge";
import { useSearchParams } from "@/lib/router";
import type {
  MessengerFailedRunThreadItem,
  MessengerRunOriginDescriptor,
  MessengerSystemThreadItem,
} from "@rudderhq/shared";

const sceneLabels: Record<MessengerRunOriginDescriptor["scene"], string> = {
  chat: "Chat Run",
  heartbeat: "Heartbeat Run",
  issue: "Issue Run",
  review: "Review Run",
  automation: "Automation Run",
};

const targetLabels: Record<MessengerRunOriginDescriptor["targetType"], string> = {
  issue: "Issue",
  chat_conversation: "Chat conversation",
  chat_message: "Chat message",
  automation_run: "Automation run",
  wakeup_request: "Wakeup request",
  manual: "Manual",
};

export function failedRunOrigin(item: MessengerSystemThreadItem): MessengerRunOriginDescriptor | null {
  if (item.kind !== "failed-runs" || !("origin" in item)) return null;
  return (item as MessengerFailedRunThreadItem).origin;
}

function triggerLabel(origin: MessengerRunOriginDescriptor) {
  if (origin.scene === "chat") return "Chat turn";
  if (origin.scene === "review") return "Review routing";
  if (origin.scene === "automation") {
    return origin.triggerKind === "system"
      ? "Automation trigger"
      : origin.triggerKind.replaceAll("_", " ");
  }
  if (origin.scene === "heartbeat") {
    if (origin.invocationSource === "timer") return "Timer";
    if (origin.triggerKind === "manual") return "Manual heartbeat";
  }
  if (origin.scene === "issue") {
    if (origin.triggerKind.includes("comment")) return "Issue comment";
    if (origin.invocationSource === "assignment") return "Issue assignment";
  }
  return origin.triggerKind.replaceAll("_", " ");
}

export function MessengerRunOrigin({ origin }: { origin: MessengerRunOriginDescriptor }) {
  const [searchParams] = useSearchParams();
  const focused = searchParams.get("originRunId") === origin.runId;
  const metadataRows = [
    ["Run ID", origin.runId],
    ["Scene", sceneLabels[origin.scene]],
    ["Target type", targetLabels[origin.targetType]],
    ["Target ID", origin.targetId],
    ["Trigger", origin.triggerKind],
    ["Invocation source", origin.invocationSource],
    ["Conversation ID", origin.conversationId],
    ["Message ID", origin.messageId],
    ["Issue ID", origin.issueId],
    ["Automation ID", origin.automationId],
    ["Automation run ID", origin.automationRunId],
    ["Wakeup request ID", origin.wakeupRequestId],
  ].filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);

  return (
    <div className="space-y-2.5 text-xs" data-testid={`messenger-run-origin-${origin.runId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-[calc(var(--radius-sm)-1px)] bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
          data-testid={`messenger-run-scene-${origin.runId}`}
        >
          {sceneLabels[origin.scene]}
        </span>
        <CopyText
          text={origin.runId}
          ariaLabel={`Copy full run ID ${origin.runId}`}
          title="Copy full run ID"
          className="rounded-[calc(var(--radius-sm)-1px)] bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
        >
          Run {origin.runId.slice(0, 8)}
        </CopyText>
        <span className="text-[11px] text-muted-foreground" data-testid={`messenger-run-trigger-${origin.runId}`}>
          {triggerLabel(origin)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {origin.sourceState === "available" ? (
          <>
            <span>Origin</span>
            <span className="font-medium text-foreground" data-testid={`messenger-run-target-${origin.runId}`}>
              {origin.targetLabel ?? targetLabels[origin.targetType]}
            </span>
            {origin.targetStatus ? <StatusBadge status={origin.targetStatus} /> : null}
          </>
        ) : (
          <span className="font-medium text-foreground" data-testid={`messenger-run-source-fallback-${origin.runId}`}>
            {origin.sourceState === "source_unavailable" ? "Source unavailable" : "Legacy/unknown origin"}
          </span>
        )}
      </div>

      <details
        id={`run-origin-${origin.runId}`}
        open={focused || undefined}
        className="rounded-[calc(var(--radius-sm)-1px)] border border-border/60 bg-muted/35 px-3 py-2"
        data-testid={`messenger-run-origin-details-${origin.runId}`}
      >
        <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground">
          Origin metadata
        </summary>
        <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-[max-content_minmax(0,1fr)]">
          {metadataRows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-[11px] text-muted-foreground">{label}</dt>
              <dd className="break-all font-mono text-[11px] text-foreground">{value}</dd>
            </div>
          ))}
          <div className="contents">
            <dt className="text-[11px] text-muted-foreground">Source</dt>
            <dd className="text-[11px] text-foreground">
              {origin.sourceState === "available"
                ? origin.targetLabel ?? "Available"
                : origin.sourceState === "source_unavailable"
                  ? "Source unavailable"
                  : "Legacy/unknown origin"}
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

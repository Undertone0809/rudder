import { AgentIdentity } from "@/components/AgentAvatar";
import { StatusBadge } from "@/components/StatusBadge";
import { Link } from "@/lib/router";
import type {
  MessengerFailedRunThreadItem,
  MessengerRunOriginDescriptor,
  MessengerRunOriginSource,
  MessengerSystemThreadItem,
} from "@rudderhq/shared";
import {
  Activity,
  ArrowUpRight,
  CircleAlert,
  FileText,
  MessageSquareText,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from "lucide-react";

const sceneLabels: Record<MessengerRunOriginDescriptor["scene"], string> = {
  chat: "Chat Run",
  heartbeat: "Heartbeat Run",
  issue: "Issue Run",
  review: "Review Run",
  automation: "Automation Run",
};

const sourceLabels: Record<MessengerRunOriginDescriptor["scene"], string> = {
  chat: "Chat",
  heartbeat: "Heartbeat",
  issue: "Issue",
  review: "Review",
  automation: "Automation",
};

const sceneIcons: Record<MessengerRunOriginDescriptor["scene"], LucideIcon> = {
  chat: MessageSquareText,
  heartbeat: Activity,
  issue: FileText,
  review: ShieldCheck,
  automation: Workflow,
};

export function failedRunOrigin(item: MessengerSystemThreadItem): MessengerRunOriginDescriptor | null {
  if (item.kind !== "failed-runs" || !("origin" in item)) return null;
  return (item as MessengerFailedRunThreadItem).origin;
}

function humanize(value: string) {
  const label = value.replaceAll("_", " ").trim();
  return label ? `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}` : "Run trigger";
}

function triggerLabel(origin: MessengerRunOriginDescriptor) {
  if (origin.scene === "chat") return "Chat turn";
  if (origin.scene === "review") return "Review routing";
  if (origin.scene === "automation") {
    return origin.triggerKind === "system"
      ? "Automation trigger"
      : humanize(origin.triggerKind);
  }
  if (origin.scene === "heartbeat") {
    if (origin.invocationSource === "timer") return "Timer";
    if (origin.triggerKind === "manual") return "Manual heartbeat";
  }
  if (origin.scene === "issue") {
    if (origin.triggerKind.includes("comment")) return "Issue comment";
    if (origin.invocationSource === "assignment") return "Issue assignment";
  }
  return humanize(origin.triggerKind);
}

function unavailableTitle(origin: MessengerRunOriginDescriptor) {
  return origin.sourceState === "source_unavailable" ? "Source unavailable" : "Legacy/unknown origin";
}

function unavailableDescription(origin: MessengerRunOriginDescriptor) {
  return origin.sourceState === "source_unavailable"
    ? `The originating ${sourceLabels[origin.scene].toLowerCase()} is no longer available.`
    : "This older run does not include a linked source.";
}

function sourceTitle(source: MessengerRunOriginSource) {
  if (source.kind === "unavailable") return null;
  if (source.kind === "heartbeat") return source.agent.name;
  return source.title;
}

function sourceStatus(source: MessengerRunOriginSource) {
  if (source.kind === "issue" || source.kind === "review" || source.kind === "automation") {
    return source.status;
  }
  if (source.kind === "heartbeat") return source.agent.status;
  return null;
}

function sourceActionLabel(source: Exclude<MessengerRunOriginSource, { kind: "unavailable" }>) {
  if (source.kind === "chat") return "Open chat message";
  if (source.kind === "issue") return "Open issue";
  if (source.kind === "review") return "Open review";
  if (source.kind === "automation") return "Open automation";
  return "Open agent";
}

export function MessengerRunOrigin({ origin }: { origin: MessengerRunOriginDescriptor }) {
  const availableSource = origin.source.kind === "unavailable" ? null : origin.source;
  const SourceIcon = availableSource ? sceneIcons[origin.scene] : CircleAlert;
  const title = availableSource ? sourceTitle(availableSource)! : unavailableTitle(origin);
  const status = availableSource ? sourceStatus(availableSource) : null;
  const description = availableSource
    ? availableSource.kind === "heartbeat"
      ? `${triggerLabel(origin)} · ${humanize(availableSource.agent.title ?? availableSource.agent.role)}`
      : triggerLabel(origin)
    : unavailableDescription(origin);

  const content = (
    <div className="flex min-w-0 items-start gap-3">
      {availableSource?.kind === "heartbeat" ? null : (
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border/70 bg-background text-muted-foreground shadow-[var(--shadow-xs)]">
          <SourceIcon className="h-4 w-4" aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="text-[11px] font-medium text-muted-foreground"
            data-testid={`messenger-run-scene-${origin.runId}`}
          >
            {sceneLabels[origin.scene]}
          </span>
          {(availableSource?.kind === "issue" || availableSource?.kind === "review") && availableSource.identifier ? (
            <span className="font-mono text-[11px] font-medium text-foreground">{availableSource.identifier}</span>
          ) : null}
          {status ? <StatusBadge status={status} /> : null}
        </div>
        <div
          className="mt-0.5 truncate text-sm font-medium leading-5 text-foreground"
          data-testid={availableSource
            ? `messenger-run-target-${origin.runId}`
            : `messenger-run-source-fallback-${origin.runId}`}
        >
          {availableSource?.kind === "heartbeat" ? (
            <AgentIdentity
              name={availableSource.agent.name}
              icon={availableSource.agent.icon}
              role={availableSource.agent.role}
              size="sm"
              className="max-w-full [&>span:last-child]:text-sm [&>span:last-child]:font-medium"
            />
          ) : title}
        </div>
        <div
          className="mt-0.5 text-xs text-muted-foreground"
          data-testid={`messenger-run-trigger-${origin.runId}`}
        >
          {description}
        </div>
      </div>
      {availableSource ? <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
    </div>
  );

  const cardClassName = "block rounded-[calc(var(--radius-sm)-1px)] border border-border/70 bg-[color:color-mix(in_oklab,var(--surface-inset)_72%,transparent)] px-3 py-2.5 text-left";

  return availableSource ? (
    <Link
      to={availableSource.href}
      className={`${cardClassName} transition-colors hover:border-[color:var(--accent-strong)]/40 hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      aria-label={`${sourceActionLabel(availableSource)}: ${title}`}
      data-testid={`messenger-run-origin-${origin.runId}`}
    >
      {content}
    </Link>
  ) : (
    <div className={cardClassName} data-testid={`messenger-run-origin-${origin.runId}`}>
      {content}
    </div>
  );
}

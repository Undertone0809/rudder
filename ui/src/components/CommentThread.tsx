import { memo, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { IssueComment, Agent } from "@rudderhq/shared";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, Copy, Link2, MoreHorizontal, Paperclip, TerminalSquare } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LiveRunForIssue } from "../api/heartbeats";
import type { TranscriptEntry } from "../agent-runtimes";
import { Identity } from "./Identity";
import { AgentIdentity } from "./AgentAvatar";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import type { MarkdownAgentMentionPreview } from "./MarkdownBody";
import type { MarkdownSkillReferencePreview } from "./SkillReferenceToken";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { StatusBadge } from "./StatusBadge";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { formatDateTime, relativeTime } from "../lib/utils";
import { formatRunDurationLabel, formatRunTimingTitle, isRunTimingActive } from "../lib/run-duration-label";
import { resolveOperatorDisplayName } from "../lib/operator-display";
import { PluginSlotOutlet } from "@/plugins/slots";
import { applyOrganizationPrefix, extractOrganizationPrefixFromPath } from "@/lib/organization-routes";

const COMMENT_ATTACHMENT_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";

interface CommentWithRunMeta extends IssueComment {
  runId?: string | null;
  runAgentId?: string | null;
}

interface LinkedRunItem {
  runId: string;
  status: string;
  agentId: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt?: Date | string | null;
  invocationSource?: string;
  triggerDetail?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
}

export interface CommentThreadActivityItem {
  id: string;
  createdAt: Date | string;
  node: ReactNode;
}

interface CommentThreadProps {
  comments: CommentWithRunMeta[];
  linkedRuns?: LinkedRunItem[];
  activityItems?: CommentThreadActivityItem[];
  orgId?: string | null;
  projectId?: string | null;
  onAdd: (body: string, reopen?: boolean) => Promise<void>;
  issueStatus?: string;
  agentMap?: Map<string, Agent>;
  imageUploadHandler?: (file: File) => Promise<string>;
  /** Fallback callback for consumers that upload files without inserting a markdown link. */
  onAttachImage?: (file: File) => Promise<void>;
  draftKey?: string;
  liveRunSlot?: React.ReactNode;
  mentions?: MentionOption[];
  onMentionQueryChange?: (query: string | null) => void;
  operatorDisplayName?: string | null;
  heading?: ReactNode;
  hideHeading?: boolean;
  emptyMessage?: string;
  escapeBackWhenEmpty?: boolean;
}

const DRAFT_DEBOUNCE_MS = 800;

export function shouldOfferReopen(issueStatus?: string) {
  return issueStatus === "done";
}

function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(draftKey: string, value: string) {
  try {
    if (value.trim()) {
      localStorage.setItem(draftKey, value);
    } else {
      localStorage.removeItem(draftKey);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

function shouldForwardComposerFocus(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return !target.closest([
    "a",
    "button",
    "input",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[role='button']",
    "[role='menuitem']",
    "[data-chat-composer-menu-item]",
  ].join(","));
}

function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function passiveFollowupLabel(contextSnapshot: Record<string, unknown> | null | undefined) {
  const passive = asRecord(asRecord(contextSnapshot)?.passiveFollowup);
  const attempt = typeof passive?.attempt === "number" ? passive.attempt : null;
  const maxAttempts = typeof passive?.maxAttempts === "number" ? passive.maxAttempts : null;
  if (!passive) return null;
  return attempt && maxAttempts ? `Passive follow-up ${attempt}/${maxAttempts}` : "Passive follow-up";
}

function shouldExpandRunByDefault(status: string): boolean {
  return status === "queued" || status === "running";
}

function shouldSkipRunRowNavigation(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest("a, button, [data-run-details]"))
    : false;
}

function buildCommentLink(commentId: string, location: ReturnType<typeof useLocation>) {
  const path = `${location.pathname}${location.search}`;
  if (typeof window === "undefined") return `${path}#comment-${commentId}`;
  return `${window.location.origin}${path}#comment-${commentId}`;
}

function timelineDateTime(date: Date | string) {
  const timestamp = new Date(date);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

function CommentActionsMenu({
  comment,
  orgId,
  projectId,
  location,
}: {
  comment: CommentWithRunMeta;
  orgId?: string | null;
  projectId?: string | null;
  location: ReturnType<typeof useLocation>;
}) {
  const [copiedAction, setCopiedAction] = useState<"content" | "link" | null>(null);

  const copyToClipboard = (action: "content" | "link", value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedAction(action);
      setTimeout(() => setCopiedAction(null), 2000);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label="Comment actions"
          title="Comment actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40 whitespace-nowrap">
        <DropdownMenuItem onSelect={() => copyToClipboard("content", comment.body)}>
          {copiedAction === "content" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          Copy content
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copyToClipboard("link", buildCommentLink(comment.id, location))}>
          {copiedAction === "link" ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
          Copy link
        </DropdownMenuItem>
        {orgId ? (
          <PluginSlotOutlet
            slotTypes={["commentContextMenuItem"]}
            entityType="comment"
            context={{
              orgId,
              projectId: projectId ?? null,
              entityId: comment.id,
              entityType: "comment",
              parentEntityId: comment.issueId,
            }}
            className="flex flex-col"
            itemClassName="inline-flex"
            missingBehavior="placeholder"
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AnimatedRunDetails({
  expanded,
  id,
  children,
}: {
  expanded: boolean;
  id: string;
  children: ReactNode;
}) {
  const [rendered, setRendered] = useState(expanded);
  const showContent = expanded || rendered;

  useEffect(() => {
    if (expanded) {
      setRendered(true);
    }
  }, [expanded]);

  return (
    <div
      id={id}
      data-run-details
      aria-hidden={!expanded}
      className={`grid motion-safe:transition-[grid-template-rows,opacity,margin-top] motion-safe:duration-200 motion-safe:ease-out motion-reduce:transition-none ${expanded ? "mt-3 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0"}`}
      onTransitionEnd={(event) => {
        if (event.currentTarget !== event.target) return;
        if (!expanded) {
          setRendered(false);
        }
      }}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="max-h-56 overflow-y-auto pr-1">
          {showContent ? children : null}
        </div>
      </div>
    </div>
  );
}

type TimelineItem =
  | { kind: "comment"; id: string; createdAtMs: number; comment: CommentWithRunMeta }
  | { kind: "run"; id: string; createdAtMs: number; run: LinkedRunItem }
  | { kind: "activity"; id: string; createdAtMs: number; activity: CommentThreadActivityItem };

const TimelineList = memo(function TimelineList({
  timeline,
  agentMap,
  orgId,
  projectId,
  highlightCommentId,
  runTranscriptById,
  runHasOutput,
  operatorDisplayName,
  agentMentions,
  skillReferences,
  emptyMessage,
}: {
  timeline: TimelineItem[];
  agentMap?: Map<string, Agent>;
  orgId?: string | null;
  projectId?: string | null;
  highlightCommentId?: string | null;
  runTranscriptById: Map<string, TranscriptEntry[]>;
  runHasOutput: (runId: string) => boolean;
  operatorDisplayName?: string | null;
  agentMentions?: MarkdownAgentMentionPreview[];
  skillReferences?: MarkdownSkillReferencePreview[];
  emptyMessage: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const organizationPrefix = extractOrganizationPrefixFromPath(location.pathname);
  const [runExpandedOverrides, setRunExpandedOverrides] = useState<Record<string, boolean>>({});

  if (timeline.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-3">
      {timeline.map((item) => {
        if (item.kind === "activity") {
          return (
            <div key={`activity:${item.id}`}>
              {item.activity.node}
            </div>
          );
        }

        if (item.kind === "run") {
          const run = item.run;
          const isActive = run.status === "queued" || run.status === "running";
          const transcript = runTranscriptById.get(run.runId) ?? [];
          const hasOutput = runHasOutput(run.runId);
          const passiveLabel = passiveFollowupLabel(run.contextSnapshot);
          const runTimestamp = run.startedAt ?? run.createdAt;
          const runTimestampTitle = formatDateTime(runTimestamp);
          const runExpanded = runExpandedOverrides[run.runId] ?? shouldExpandRunByDefault(run.status);
          const toggleLabel = runExpanded ? "Hide details" : "Show details";
          const agent = agentMap?.get(run.agentId);
          const agentName = agent?.name ?? run.agentId.slice(0, 8);
          const runDurationLabel = run.finishedAt || isRunTimingActive(run) ? formatRunDurationLabel(run) : null;
          const runTimingTitle = formatRunTimingTitle(run);
          const runDetailPath = applyOrganizationPrefix(`/agents/${run.agentId}/runs/${run.runId}`, organizationPrefix);
          const openRunDetail = () => {
            navigate(runDetailPath);
          };
          const handleRunRowClick = (event: MouseEvent<HTMLElement>) => {
            if (shouldSkipRunRowNavigation(event.target)) return;
            openRunDetail();
          };
          const handleRunRowKeyDown = (event: KeyboardEvent<HTMLElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openRunDetail();
          };
          const statusBadge = (
            <Link
              to={runDetailPath}
              className="inline-flex shrink-0 rounded-[calc(var(--radius-sm)-1px)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              aria-label={`Open ${run.status.replace("_", " ")} run details`}
            >
              <StatusBadge status={run.status} />
            </Link>
          );
          const toggleButton = (
            <button
              type="button"
              aria-label={toggleLabel}
              aria-expanded={runExpanded}
              aria-controls={`run-output-${run.runId}`}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-background/70 text-muted-foreground motion-safe:transition-colors hover:bg-accent hover:text-foreground motion-reduce:transition-none"
              onClick={() => {
                setRunExpandedOverrides((current) => ({
                  ...current,
                  [run.runId]: !runExpanded,
                }));
              }}
            >
              <ChevronDown className={`h-3.5 w-3.5 motion-safe:transition-transform motion-reduce:transition-none ${runExpanded ? "rotate-180" : ""}`} />
            </button>
          );

          return (
            <div
              key={`run:${run.runId}`}
              aria-label="Agent run"
              data-run-id={run.runId}
              role="link"
              tabIndex={0}
              className={`overflow-hidden rounded-sm border border-dashed border-border bg-muted/35 motion-safe:transition-[padding,background-color,border-color] motion-safe:duration-200 motion-safe:ease-out hover:border-border/80 hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none ${runExpanded ? "p-3" : "px-3 py-1"}`}
              onClick={handleRunRowClick}
              onKeyDown={handleRunRowKeyDown}
            >
              {runExpanded ? (
                <>
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <Link to={`/agents/${run.agentId}`} className="hover:underline">
                      <AgentIdentity
                        name={agentName}
                        icon={agent?.icon}
                        role={agent?.role}
                        size="sm"
                      />
                    </Link>
                    <div className="shrink-0 text-right">
                      <time
                        className="block text-xs text-muted-foreground"
                        dateTime={timelineDateTime(runTimestamp)}
                        title={runTimestampTitle}
                      >
                        {relativeTime(runTimestamp)}
                      </time>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
                      <TerminalSquare className="h-3.5 w-3.5" />
                      Run
                    </span>
                    {statusBadge}
                    {runDurationLabel ? (
                      <span
                        className="inline-flex h-7 shrink-0 items-center text-muted-foreground"
                        title={runTimingTitle || undefined}
                      >
                        {runDurationLabel}
                      </span>
                    ) : null}
                    {passiveLabel && (
                      <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        {passiveLabel}
                      </span>
                    )}
                    <span className="ml-auto">{toggleButton}</span>
                  </div>
                </>
              ) : (
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 text-xs">
                  <div className="flex h-7 min-w-0 items-center gap-2">
                    <Link to={`/agents/${run.agentId}`} className="min-w-0 shrink hover:underline">
                      <AgentIdentity
                        name={agentName}
                        icon={agent?.icon}
                        role={agent?.role}
                        size="sm"
                        className="h-7 max-w-[12rem] items-center"
                      />
                    </Link>
                    <span className="inline-flex h-7 shrink-0 items-center gap-1 font-medium text-muted-foreground">
                      <TerminalSquare className="h-3.5 w-3.5" />
                      Run
                    </span>
                    {statusBadge}
                    {runDurationLabel ? (
                      <span
                        className="inline-flex h-7 shrink-0 items-center text-muted-foreground"
                        title={runTimingTitle || undefined}
                      >
                        {runDurationLabel}
                      </span>
                    ) : null}
                    {passiveLabel && (
                      <span className="inline-flex h-7 shrink-0 items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        {passiveLabel}
                      </span>
                    )}
                  </div>
                  <time
                    className="hidden h-7 shrink-0 items-center text-muted-foreground sm:inline-flex"
                    dateTime={timelineDateTime(runTimestamp)}
                    title={runTimestampTitle}
                  >
                    {relativeTime(runTimestamp)}
                  </time>
                  {toggleButton}
                </div>
              )}
              <AnimatedRunDetails expanded={runExpanded} id={`run-output-${run.runId}`}>
                <RunTranscriptView
                  entries={transcript}
                  density="compact"
                  limit={4}
                  streaming={isActive}
                  collapseStdout
                  emptyMessage={
                    hasOutput
                      ? "Waiting for transcript parsing..."
                      : isActive
                        ? `Run ${run.status}. Waiting for output...`
                        : "No run output captured."
                  }
                />
              </AnimatedRunDetails>
            </div>
          );
        }

        const comment = item.comment;
        const isHighlighted = highlightCommentId === comment.id;
        const commentTimestampTitle = formatDateTime(comment.createdAt);
        return (
          <div
            key={comment.id}
            id={`comment-${comment.id}`}
            className={`border p-3 overflow-hidden min-w-0 rounded-sm transition-colors duration-1000 ${isHighlighted ? "border-primary/50 bg-primary/5" : "border-border"}`}
          >
            <div className="flex items-center justify-between mb-1">
              {comment.authorAgentId ? (
                <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                  <AgentIdentity
                    name={agentMap?.get(comment.authorAgentId)?.name ?? comment.authorAgentId.slice(0, 8)}
                    icon={agentMap?.get(comment.authorAgentId)?.icon}
                    role={agentMap?.get(comment.authorAgentId)?.role}
                    size="sm"
                  />
                </Link>
              ) : (
                <Identity name={resolveOperatorDisplayName(operatorDisplayName)} size="sm" />
              )}
              <span className="flex items-center gap-1.5">
                <a
                  href={`#comment-${comment.id}`}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                  title={commentTimestampTitle}
                  aria-label={`Comment posted ${commentTimestampTitle}`}
                >
                  <time dateTime={timelineDateTime(comment.createdAt)}>
                    {relativeTime(comment.createdAt)}
                  </time>
                </a>
                <CommentActionsMenu
                  comment={comment}
                  orgId={orgId}
                  projectId={projectId}
                  location={location}
                />
              </span>
            </div>
            <MarkdownBody className="text-sm" agentMentions={agentMentions} skillReferences={skillReferences}>{comment.body}</MarkdownBody>
            {orgId ? (
              <div className="mt-2 space-y-2">
                <PluginSlotOutlet
                  slotTypes={["commentAnnotation"]}
                  entityType="comment"
                  context={{
                    orgId,
                    projectId: projectId ?? null,
                    entityId: comment.id,
                    entityType: "comment",
                    parentEntityId: comment.issueId,
                  }}
                  className="space-y-2"
                  itemClassName="rounded-md"
                  missingBehavior="placeholder"
                />
              </div>
            ) : null}
            {comment.runId && (
              <div className="mt-2 pt-2 border-t border-border/60">
                {comment.runAgentId ? (
                  <Link
                    to={`/agents/${comment.runAgentId}/runs/${comment.runId}`}
                    className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                  >
                    run {comment.runId.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground">
                    run {comment.runId.slice(0, 8)}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

export function CommentThread({
  comments,
  linkedRuns = [],
  activityItems = [],
  orgId,
  projectId,
  onAdd,
  issueStatus,
  agentMap,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  liveRunSlot,
  mentions: providedMentions,
  onMentionQueryChange,
  operatorDisplayName,
  heading,
  hideHeading = false,
  emptyMessage = "No comments or runs yet.",
  escapeBackWhenEmpty = false,
}: CommentThreadProps) {
  const [body, setBody] = useState("");
  const canReopen = shouldOfferReopen(issueStatus);
  const [reopen, setReopen] = useState(canReopen);
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const composerSurfaceRef = useRef<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const location = useLocation();
  const lastHandledCommentHashRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const timeline = useMemo<TimelineItem[]>(() => {
    const commentItems: TimelineItem[] = comments.map((comment) => ({
      kind: "comment",
      id: comment.id,
      createdAtMs: new Date(comment.createdAt).getTime(),
      comment,
    }));
    const runItems: TimelineItem[] = linkedRuns.map((run) => ({
      kind: "run",
      id: run.runId,
      createdAtMs: new Date(run.startedAt ?? run.createdAt).getTime(),
      run,
    }));
    const activityTimelineItems: TimelineItem[] = activityItems.map((activity) => ({
      kind: "activity",
      id: activity.id,
      createdAtMs: new Date(activity.createdAt).getTime(),
      activity,
    }));
    const kindOrder: Record<TimelineItem["kind"], number> = {
      activity: 0,
      comment: 1,
      run: 2,
    };
    return [...commentItems, ...runItems, ...activityTimelineItems].sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind];
      if (a.kind === b.kind) return a.id.localeCompare(b.id);
      return 0;
    });
  }, [activityItems, comments, linkedRuns]);

  const transcriptRuns = useMemo<LiveRunForIssue[]>(() => {
    return linkedRuns.map((run) => {
      const agent = agentMap?.get(run.agentId);
      return {
        id: run.runId,
        status: run.status,
        invocationSource: "issue_timeline",
        triggerDetail: null,
        startedAt: typeof run.startedAt === "string" ? run.startedAt : run.startedAt?.toISOString() ?? null,
        finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : run.finishedAt?.toISOString() ?? null,
        createdAt: typeof run.createdAt === "string" ? run.createdAt : run.createdAt.toISOString(),
        agentId: run.agentId,
        agentName: agent?.name ?? run.agentId.slice(0, 8),
        agentRuntimeType: agent?.agentRuntimeType ?? "process",
        issueId: null,
      };
    });
  }, [agentMap, linkedRuns]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: transcriptRuns,
    orgId,
    maxChunksPerRun: 120,
  });

  // Build mention options from agent map (exclude terminated agents)
  const mentions = useMemo<MentionOption[]>(() => {
    if (providedMentions) return providedMentions;
    if (!agentMap) return [];
    return Array.from(agentMap.values())
      .filter((a) => a.status !== "terminated")
      .map((a) => ({
        id: `agent:${a.id}`,
        name: formatChatAgentLabel(a),
        kind: "agent",
        agentId: a.id,
        agentIcon: a.icon,
        agentRole: a.role,
      }));
  }, [agentMap, providedMentions]);

  const skillReferences = useMemo<MarkdownSkillReferencePreview[]>(() => (
    mentions
      .filter((mention) => mention.kind === "skill" && mention.skillMarkdownTarget)
      .map((mention) => ({
        href: mention.skillMarkdownTarget!,
        label: mention.skillRefLabel ?? mention.name,
        displayName: mention.skillDisplayName ?? mention.name,
        description: mention.skillDescription,
        categoryLabel: mention.skillCategoryLabel,
        locationLabel: mention.skillLocationLabel,
        detailsHref: mention.skillDetailsHref,
      }))
  ), [mentions]);

  const agentMentions = useMemo<MarkdownAgentMentionPreview[]>(() => (
    mentions
      .filter((mention) => mention.kind === "agent" && mention.agentId)
      .map((mention) => ({
        name: mention.name,
        agentId: mention.agentId!,
        agentIcon: mention.agentIcon,
      }))
  ), [mentions]);

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setReopen(canReopen);
  }, [canReopen]);

  useEffect(() => {
    const hash = location.hash;
    if (!hash.startsWith("#comment-") || comments.length === 0) return;
    const commentId = hash.slice("#comment-".length);
    const navigationKey = `${location.key}:${hash}`;
    if (lastHandledCommentHashRef.current === navigationKey) return;

    const el = document.getElementById(`comment-${commentId}`);
    if (el) {
      lastHandledCommentHashRef.current = navigationKey;
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      setHighlightCommentId(commentId);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      highlightTimerRef.current = setTimeout(() => {
        setHighlightCommentId(null);
        highlightTimerRef.current = null;
      }, 3000);
    }
  }, [location.hash, location.key, comments.length]);

  async function handleSubmit() {
    const currentMarkdown = editorRef.current?.getMarkdown?.() ?? body;
    const trimmed = currentMarkdown.trim();
    if (!trimmed) return;
    const reopenRequested = canReopen && reopen ? true : undefined;

    setSubmitting(true);
    try {
      await onAdd(trimmed, reopenRequested);
      setBody("");
      if (draftKey) clearDraft(draftKey);
      setReopen(canReopen);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      if (imageUploadHandler) {
        const url = await imageUploadHandler(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = file.type.startsWith("image/")
          ? `![${safeName}](${url})`
          : `[${safeName}](${url})`;
        setBody((prev) => prev ? `${prev}\n\n${markdown}` : markdown);
      } else if (onAttachImage) {
        await onAttachImage(file);
      }
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  const canSubmit = !submitting && !!body.trim();
  const focusComposerEditor = (event: MouseEvent<HTMLDivElement>) => {
    if (!shouldForwardComposerFocus(event.target)) return;
    event.preventDefault();
    editorRef.current?.focus();
  };

  return (
    <div className="space-y-4">
      {!hideHeading && (
        heading ?? <h3 className="text-sm font-semibold">Comments &amp; Runs ({timeline.length})</h3>
      )}

      <TimelineList
        timeline={timeline}
        agentMap={agentMap}
        orgId={orgId}
        projectId={projectId}
        highlightCommentId={highlightCommentId}
        runTranscriptById={transcriptByRun}
        runHasOutput={hasOutputForRun}
        operatorDisplayName={operatorDisplayName}
        agentMentions={agentMentions}
        skillReferences={skillReferences}
        emptyMessage={emptyMessage}
      />

      {liveRunSlot}

      <div
        ref={composerSurfaceRef}
        className="chat-composer rounded-[var(--radius-lg)] p-3"
        data-issue-detail-escape-back={escapeBackWhenEmpty ? (body.trim() ? "dirty" : "empty") : undefined}
        onMouseDown={focusComposerEditor}
      >
        <MarkdownEditor
          ref={editorRef}
          engine="milkdown"
          value={body}
          onChange={setBody}
          placeholder="Leave a comment..."
          mentions={mentions}
          onMentionQueryChange={onMentionQueryChange}
          mentionMenuAnchorRef={composerSurfaceRef}
          mentionMenuPlacement="container"
          onSubmit={handleSubmit}
          imageUploadHandler={imageUploadHandler}
          className="rounded-[var(--radius-md)] bg-transparent"
          contentClassName="min-h-[64px] bg-transparent text-sm leading-6 text-foreground"
          bordered={false}
        />
        <div className="mt-3 flex items-center justify-end gap-3">
          {(imageUploadHandler || onAttachImage) && (
            <div className="mr-auto flex items-center gap-3">
              <input
                ref={attachInputRef}
                type="file"
                accept={COMMENT_ATTACHMENT_ACCEPT}
                className="hidden"
                onChange={handleAttachFile}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => attachInputRef.current?.click()}
                disabled={attaching}
                title="Attach file"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>
          )}
          {canReopen ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={reopen}
                onChange={(e) => setReopen(e.target.checked)}
                className="rounded border-border"
              />
              Re-open
            </label>
          ) : null}
          <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting ? "Posting..." : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

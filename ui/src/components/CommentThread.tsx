import { memo, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type { IssueComment, Agent } from "@rudderhq/shared";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, Copy, Paperclip, TerminalSquare } from "lucide-react";
import type { LiveRunForIssue } from "../api/heartbeats";
import type { TranscriptEntry } from "../agent-runtimes";
import { Identity } from "./Identity";
import { AgentIdentity } from "./AgentAvatar";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import type { MarkdownSkillReferencePreview } from "./SkillReferenceToken";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { StatusBadge } from "./StatusBadge";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { formatDateTime } from "../lib/utils";
import { resolveOperatorDisplayName } from "../lib/operator-display";
import { PluginSlotOutlet } from "@/plugins/slots";

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
  operatorDisplayName?: string | null;
  heading?: ReactNode;
  hideHeading?: boolean;
  emptyMessage?: string;
  escapeBackWhenEmpty?: boolean;
}

const DRAFT_DEBOUNCE_MS = 800;
const BARE_AGENT_MENTION_NAME_RE = /^[^\s@,!?.]+$/u;

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

function shouldCollapseRunByDefault(status: string): boolean {
  return status === "failed" || status === "timed_out" || status === "cancelled";
}

function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground transition-colors"
      title="Copy as markdown"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
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
  skillReferences,
  agentMentionPreviews,
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
  skillReferences?: MarkdownSkillReferencePreview[];
  agentMentionPreviews?: Array<{ name: string; agentId: string; agentIcon?: string | null }>;
  emptyMessage: string;
}) {
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
          const runExpanded = runExpandedOverrides[run.runId] ?? !shouldCollapseRunByDefault(run.status);
          const toggleLabel = runExpanded ? "Hide details" : "Show details";
          const agent = agentMap?.get(run.agentId);
          const agentName = agent?.name ?? run.agentId.slice(0, 8);
          const toggleButton = (
            <button
              type="button"
              aria-expanded={runExpanded}
              aria-controls={`run-output-${run.runId}`}
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border bg-background/70 px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => {
                setRunExpandedOverrides((current) => ({
                  ...current,
                  [run.runId]: !runExpanded,
                }));
              }}
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${runExpanded ? "rotate-180" : ""}`} />
              {toggleLabel}
            </button>
          );

          if (!runExpanded) {
            return (
              <div
                key={`run:${run.runId}`}
                aria-label="Agent run output"
                className="overflow-hidden rounded-sm border border-dashed border-border bg-muted/35 px-3 py-1"
              >
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <Link to={`/agents/${run.agentId}`} className="min-w-0 shrink hover:underline">
                    <AgentIdentity
                      name={agentName}
                      icon={agent?.icon}
                      role={agent?.role}
                      size="xs"
                    />
                  </Link>
                  <span className="inline-flex shrink-0 items-center gap-1 font-medium text-muted-foreground">
                    <TerminalSquare className="h-3.5 w-3.5" />
                    Run output
                  </span>
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.runId}`}
                    className="inline-flex shrink-0 items-center rounded-md border border-border bg-accent/40 px-2 py-1 font-mono text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
                  >
                    {run.runId.slice(0, 8)}
                  </Link>
                  <StatusBadge status={run.status} />
                  {passiveLabel && (
                    <span className="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      {passiveLabel}
                    </span>
                  )}
                  <span className="ml-auto hidden shrink-0 text-muted-foreground sm:inline">
                    {formatDateTime(run.startedAt ?? run.createdAt)}
                  </span>
                  {toggleButton}
                </div>
              </div>
            );
          }

          return (
            <div
              key={`run:${run.runId}`}
              aria-label="Agent run output"
              className="overflow-hidden rounded-sm border border-dashed border-border bg-muted/35 p-3"
            >
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
                  <span className="block text-xs text-muted-foreground">
                    {formatDateTime(run.startedAt ?? run.createdAt)}
                  </span>
                </div>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
                  <TerminalSquare className="h-3.5 w-3.5" />
                  Run output
                </span>
                <Link
                  to={`/agents/${run.agentId}/runs/${run.runId}`}
                  className="inline-flex items-center rounded-md border border-border bg-accent/40 px-2 py-1 font-mono text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
                >
                  {run.runId.slice(0, 8)}
                </Link>
                <StatusBadge status={run.status} />
                {passiveLabel && (
                  <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    {passiveLabel}
                  </span>
                )}
                <span className="ml-auto">{toggleButton}</span>
              </div>
              {runExpanded ? (
                <div id={`run-output-${run.runId}`} className="max-h-56 overflow-y-auto pr-1">
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
                </div>
              ) : null}
            </div>
          );
        }

        const comment = item.comment;
        const isHighlighted = highlightCommentId === comment.id;
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
                    className="flex flex-wrap items-center gap-1.5"
                    itemClassName="inline-flex"
                    missingBehavior="placeholder"
                  />
                ) : null}
                <a
                  href={`#comment-${comment.id}`}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                >
                  {formatDateTime(comment.createdAt)}
                </a>
                <CopyMarkdownButton text={comment.body} />
              </span>
            </div>
            <MarkdownBody
              className="text-sm"
              agentMentions={agentMentionPreviews}
              skillReferences={skillReferences}
            >
              {comment.body}
            </MarkdownBody>
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
        finishedAt: null,
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

  const agentMentionPreviews = useMemo(
    () => mentions
      .filter((mention) => mention.kind === "agent" && mention.agentId)
      .flatMap((mention) => {
        const baseName = mention.name.replace(/\s+\([^)]*\)$/u, "").trim();
        const preview = {
          agentId: mention.agentId!,
          agentIcon: mention.agentIcon,
        };
        const names = baseName && baseName !== mention.name
          ? [{ ...preview, name: mention.name }, { ...preview, name: baseName }]
          : [{ ...preview, name: mention.name }];
        return names.filter((candidate) => BARE_AGENT_MENTION_NAME_RE.test(candidate.name));
      }),
    [mentions],
  );

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
    const trimmed = body.trim();
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
        skillReferences={skillReferences}
        agentMentionPreviews={agentMentionPreviews}
        emptyMessage={emptyMessage}
      />

      {liveRunSlot}

      <div
        ref={composerSurfaceRef}
        className="chat-composer rounded-[var(--radius-lg)] p-3"
        data-issue-detail-escape-back={escapeBackWhenEmpty ? (body.trim() ? "dirty" : "empty") : undefined}
      >
        <MarkdownEditor
          ref={editorRef}
          value={body}
          onChange={setBody}
          placeholder="Leave a comment..."
          mentions={mentions}
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

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDialog } from "@/context/DialogContext";
import { applyOrganizationPrefix, extractOrganizationPrefixFromPath, toOrganizationRelativePath } from "@/lib/organization-routes";
import type { Agent, InstanceLocale } from "@rudderhq/shared";
import { buildIssueMentionHref } from "@rudderhq/shared";
import { Check, ChevronDown, Copy, CornerDownRight, Link2, MoreHorizontal, Paperclip, Pencil, TerminalSquare, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { TranscriptEntry } from "../agent-runtimes";
import { translateLegacyString } from "../i18n/legacyPhrases";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { resolveOperatorDisplayName } from "../lib/operator-display";
import { formatRunDurationLabel, formatRunTimingTitle, isRunTimingActive } from "../lib/run-duration-label";
import { formatDateTime, relativeTime } from "../lib/utils";
import { AgentIdentity } from "./AgentAvatar";
import { commentThreadTranscriptRuns, type LinkedRunItem } from "./CommentThread.runs";
import { useCommentSubmit } from "./CommentThread.submit";
import {
  buildCommentThreadTimeline,
  projectCommentThreadTimeline,
  toIssueTimelineDisclosureItems,
  type CommentThreadActivityItem,
  type CommentWithRunMeta,
  type CommentThreadTimelineRenderItem as TimelineRenderItem
} from "./CommentThread.timeline";
import { CommentThreadTimelineRows } from "./CommentThreadTimelineRows";
import { Identity } from "./Identity";
import {
  IssueTimelineDisclosureDivider,
  useIssueTimelineDisclosure,
  type CommentThreadProgressiveDisclosure,
} from "./IssueTimelineDisclosure";
import type { MarkdownAgentMentionPreview, MarkdownLinkClickHandler } from "./MarkdownBody";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import type { MarkdownSkillReferencePreview } from "./SkillReferenceToken";
import { StatusBadge } from "./StatusBadge";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

const COMMENT_ATTACHMENT_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";
const COMMENT_HASH_SCROLL_RETRY_DELAYS_MS = [120, 360, 900] as const;
const COMMENT_SCROLL_CENTER_TOLERANCE_PX = 24;
const COMMENT_HASH_SCROLL_CANCEL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
const MOBILE_COMMENT_COMPOSER_MIN_HEIGHT_PX = 30;
const MOBILE_COMMENT_COMPOSER_MAX_HEIGHT_PX = 160;
const MOBILE_COMMENT_COMPOSER_MAX_VIEWPORT_RATIO = 0.24;

export type { CommentThreadActivityItem } from "./CommentThread.timeline";

interface CommentThreadProps {
  comments: CommentWithRunMeta[];
  linkedRuns?: LinkedRunItem[];
  activityItems?: CommentThreadActivityItem[];
  orgId?: string | null;
  projectId?: string | null;
  onAdd: (body: string, reopen?: boolean, intent?: "comment" | "steer") => Promise<void>;
  onUpdate?: (commentId: string, body: string) => Promise<void>;
  onDelete?: (commentId: string) => Promise<void>;
  currentUserId?: string | null;
  issueStatus?: string;
  locale?: InstanceLocale;
  reopenWillWakeAgent?: boolean;
  steerRunId?: string | null;
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
  fixedComposer?: boolean;
  fixedComposerTimelineScroll?: boolean;
  composerReplacement?: ReactNode;
  timelineScrollElementRef?: RefObject<HTMLElement | null>;
  progressiveDisclosure?: CommentThreadProgressiveDisclosure;
}

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

function findScrollContainer(element: HTMLElement) {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflow = `${style.overflow} ${style.overflowY}`;
    if (/(auto|scroll|overlay)/.test(overflow)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function scrollCommentElementToCenter(element: HTMLElement, behavior: ScrollBehavior) {
  const container = findScrollContainer(element);
  if (!container || typeof container.scrollTo !== "function") {
    element.scrollIntoView?.({ behavior, block: "center", inline: "nearest" });
    return { container: null, scrollTop: null };
  }

  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const nextTop = container.scrollTop
    + (elementRect.top - containerRect.top)
    - ((container.clientHeight - elementRect.height) / 2);

  container.scrollTo({
    top: Math.max(0, nextTop),
    behavior,
  });
  return {
    container,
    scrollTop: Math.max(0, nextTop),
  };
}

function measureCommentCenterDelta(element: HTMLElement) {
  const container = findScrollContainer(element);
  const elementRect = element.getBoundingClientRect();
  const elementCenter = elementRect.top + elementRect.height / 2;
  if (!container) return Math.abs(elementCenter - window.innerHeight / 2);

  const containerRect = container.getBoundingClientRect();
  return Math.abs(elementCenter - (containerRect.top + containerRect.height / 2));
}

function rememberMainScrollTopForPath(pathname: string, scrollTop: number | null) {
  if (scrollTop === null || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`workspace-main:${toOrganizationRelativePath(pathname)}`, String(scrollTop));
  } catch {
    // Ignore restricted storage; the scroll itself already happened.
  }
}

export function extractIssueRouteRefFromPathname(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  const issuesIndex = segments.lastIndexOf("issues");
  const routeRef = issuesIndex >= 0 ? segments[issuesIndex + 1] : null;
  return routeRef ? decodeURIComponent(routeRef) : null;
}

function extractIssueRouteRef(location: ReturnType<typeof useLocation>) {
  return extractIssueRouteRefFromPathname(location.pathname);
}

export function commentIdFromIssueCommentHash(hash: string) {
  if (!hash.startsWith("#comment-")) return null;
  const encoded = hash.slice("#comment-".length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function resolveCurrentIssueCommentLink(input: {
  href: string;
  baseHref: string;
  currentPathname: string;
  currentIssueId: string | null;
  currentIssueRef: string | null;
}) {
  let target: URL;
  let base: URL;
  try {
    base = new URL(input.baseHref);
    target = new URL(input.href, base);
  } catch {
    return null;
  }

  if (target.origin !== base.origin) return null;
  const commentId = commentIdFromIssueCommentHash(target.hash);
  if (!commentId) return null;

  const targetIssueRef = extractIssueRouteRefFromPathname(target.pathname);
  if (!targetIssueRef) return null;

  const currentIssueRef = input.currentIssueRef ?? extractIssueRouteRefFromPathname(input.currentPathname);
  if (currentIssueRef && targetIssueRef === currentIssueRef) return commentId;
  if (input.currentIssueId && targetIssueRef === input.currentIssueId) return commentId;
  return null;
}

export function resolveInternalMarkdownRoute(input: {
  href: string;
  baseHref: string;
}): { pathname: string; search: string; hash: string } | null {
  let target: URL;
  let base: URL;
  try {
    base = new URL(input.baseHref);
    target = new URL(input.href, base);
  } catch {
    return null;
  }

  if (target.origin !== base.origin) return null;
  if (target.pathname === base.pathname && target.search === base.search && target.hash === base.hash) return null;
  if (/^\/api(?:\/|$)/.test(target.pathname)) return null;

  return {
    pathname: target.pathname,
    search: target.search,
    hash: target.hash,
  };
}

function buildCommentMarkdownLink(comment: CommentWithRunMeta, location: ReturnType<typeof useLocation>) {
  const href = buildIssueMentionHref(comment.issueId, extractIssueRouteRef(location), comment.id);
  return `[Issue comment ${comment.id.slice(0, 8)}](${href})`;
}

function buildCommentPreview(body: string) {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[\s>*+-]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
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
  collapsed,
  canEdit,
  canDelete,
  onToggleCollapsed,
  onEdit,
  onDelete,
}: {
  comment: CommentWithRunMeta;
  orgId?: string | null;
  projectId?: string | null;
  location: ReturnType<typeof useLocation>;
  collapsed: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onToggleCollapsed: () => void;
  onEdit: () => void;
  onDelete: () => void;
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
          className={collapsed
            ? "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-background/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            : "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"}
          aria-label={collapsed ? "Collapsed comment actions" : "Comment actions"}
          title={collapsed ? "Collapsed comment actions" : "Comment actions"}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 whitespace-nowrap">
        <DropdownMenuItem onSelect={() => copyToClipboard("content", comment.body)}>
          {copiedAction === "content" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          Copy content
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copyToClipboard("link", buildCommentMarkdownLink(comment, location))}>
          {copiedAction === "link" ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggleCollapsed}>
          <ChevronDown className={`h-3.5 w-3.5 ${collapsed ? "rotate-180" : ""}`} />
          {collapsed ? "Expand comment" : "Collapse comment"}
        </DropdownMenuItem>
        {canEdit || canDelete ? (
          <>
            <DropdownMenuSeparator />
            {canEdit ? (
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </DropdownMenuItem>
            ) : null}
            {canDelete ? (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={(event) => {
                  event.preventDefault();
                  onDelete();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AnimatedCommentBody({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  const [rendered, setRendered] = useState(!collapsed);
  const showContent = !collapsed || rendered;

  useEffect(() => {
    if (!collapsed) {
      setRendered(true);
    }
  }, [collapsed]);

  return (
    <div
      data-comment-body-collapsed={collapsed ? "true" : undefined}
      aria-hidden={collapsed}
      className={`motion-grid-collapse grid ${collapsed ? "mt-0 grid-rows-[0fr] opacity-0" : "mt-2 grid-rows-[1fr] opacity-100"}`}
      onTransitionEnd={(event) => {
        if (event.currentTarget !== event.target) return;
        if (collapsed) {
          setRendered(false);
        }
      }}
    >
      <div className="min-h-0 overflow-hidden">
        {showContent ? children : null}
      </div>
    </div>
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
      className={`motion-grid-collapse grid ${expanded ? "mt-3 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0"}`}
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

const TimelineList = memo(function TimelineList({
  timeline,
  agentMap,
  orgId,
  projectId,
  highlightCommentId,
  runExpandedOverrides,
  onToggleRunExpanded,
  runTranscriptById,
  runHasOutput,
  operatorDisplayName,
  agentMentions,
  skillReferences,
  mentions,
  emptyMessage,
  currentUserId,
  onUpdate,
  onDelete,
  imageUploadHandler,
  onMarkdownLinkClick,
  reserveHashScrollEndSpace,
  timelineRegionLabel,
  scrollElementRef,
  onTargetMounted,
  mountAll,
  onRevealMore,
  timelineRegionId,
  disclosureAnnouncement,
  locale,
}: {
  timeline: TimelineRenderItem[];
  agentMap?: Map<string, Agent>;
  orgId?: string | null;
  projectId?: string | null;
  highlightCommentId?: string | null;
  runExpandedOverrides: Record<string, boolean>;
  onToggleRunExpanded: (runId: string, expanded: boolean) => void;
  runTranscriptById: Map<string, TranscriptEntry[]>;
  runHasOutput: (runId: string) => boolean;
  operatorDisplayName?: string | null;
  agentMentions?: MarkdownAgentMentionPreview[];
  skillReferences?: MarkdownSkillReferencePreview[];
  mentions: MentionOption[];
  emptyMessage: string;
  currentUserId?: string | null;
  onUpdate?: (commentId: string, body: string) => Promise<void>;
  onDelete?: (commentId: string) => Promise<void>;
  imageUploadHandler?: (file: File) => Promise<string>;
  onMarkdownLinkClick?: MarkdownLinkClickHandler;
  reserveHashScrollEndSpace?: boolean;
  timelineRegionLabel?: string;
  scrollElementRef?: RefObject<HTMLElement | null>;
  onTargetMounted?: (key: string) => void;
  mountAll?: boolean;
  onRevealMore?: (keyboard: boolean, dividerTop: number) => void;
  timelineRegionId: string;
  disclosureAnnouncement?: string;
  locale: InstanceLocale;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { confirm } = useDialog();
  const organizationPrefix = extractOrganizationPrefixFromPath(location.pathname);
  const [commentCollapsedOverrides, setCommentCollapsedOverrides] = useState<Record<string, boolean>>({});
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editAttaching, setEditAttaching] = useState(false);
  const editEditorRef = useRef<MarkdownEditorRef>(null);
  const editAttachInputRef = useRef<HTMLInputElement | null>(null);

  async function handleEditAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(evt.target.files ?? []);
    if (files.length === 0 || !imageUploadHandler) return;
    setEditAttaching(true);
    try {
      const snippets: string[] = [];
      for (const file of files) {
        const url = await imageUploadHandler(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        snippets.push(file.type.startsWith("image/")
          ? `![${safeName}](${url})`
          : `[${safeName}](${url})`);
      }
      const currentMarkdown = editEditorRef.current?.getMarkdown?.() ?? editBody;
      const markdown = snippets.join("\n\n");
      setEditBody(currentMarkdown ? `${currentMarkdown}\n\n${markdown}` : markdown);
    } finally {
      setEditAttaching(false);
      if (editAttachInputRef.current) editAttachInputRef.current.value = "";
    }
  }

  if (timeline.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  const renderTimelineItem = (item: TimelineRenderItem) => {
        if (item.kind === "disclosure") {
          return (
            <IssueTimelineDisclosureDivider
              hiddenCount={item.hiddenCount}
              locale={locale}
              onRevealMore={onRevealMore}
              timelineRegionId={timelineRegionId}
            />
          );
        }

        if (item.kind === "activity") {
          return (
            <div>
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
          const runSummaryLabel = runDurationLabel ?? "Run";
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
                onToggleRunExpanded(run.runId, !runExpanded);
              }}
            >
              <ChevronDown className={`h-3.5 w-3.5 motion-safe:transition-transform motion-reduce:transition-none ${runExpanded ? "rotate-180" : ""}`} />
            </button>
          );

          return (
            <div
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
                    <span
                      className="inline-flex h-7 shrink-0 items-center gap-1 font-medium text-muted-foreground"
                      title={runTimingTitle || undefined}
                    >
                      <TerminalSquare className="h-3.5 w-3.5" />
                      {runSummaryLabel}
                    </span>
                    {statusBadge}
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
                    <Link to={`/agents/${run.agentId}`} className="min-w-0 shrink overflow-hidden hover:underline">
                      <AgentIdentity
                        name={agentName}
                        icon={agent?.icon}
                        role={agent?.role}
                        size="sm"
                        className="h-7 w-full min-w-0 max-w-[12rem] items-center"
                      />
                    </Link>
                    <span
                      className="inline-flex h-7 shrink-0 items-center gap-1 font-medium text-muted-foreground"
                      title={runTimingTitle || undefined}
                    >
                      <TerminalSquare className="h-3.5 w-3.5" />
                      {runSummaryLabel}
                    </span>
                    {statusBadge}
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
                  presentation="chat"
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
        const isDeleted = !!comment.deletedAt;
        if (isDeleted) return null;
        const isEdited = new Date(comment.updatedAt).getTime() > new Date(comment.createdAt).getTime() + 1000;
        const canEdit = !!currentUserId && !comment.authorAgentId && comment.authorUserId === currentUserId;
        const canDelete = !!currentUserId && (canEdit || !!comment.authorAgentId);
        const isEditing = editingCommentId === comment.id;
        const commentCollapsed = commentCollapsedOverrides[comment.id] === true && !isEditing;
        const commentPreview = buildCommentPreview(comment.body);
        const handleToggleCollapsed = () => {
          setCommentCollapsedOverrides((current) => ({
            ...current,
            [comment.id]: !commentCollapsed,
          }));
        };
        const handleStartEdit = () => {
          setCommentCollapsedOverrides((current) => ({
            ...current,
            [comment.id]: false,
          }));
          setEditingCommentId(comment.id);
          setEditBody(comment.body);
        };
        const handleCancelEdit = () => {
          setEditingCommentId(null);
          setEditBody("");
        };
        const handleSaveEdit = async () => {
          if (!onUpdate) return;
          const nextBody = (editEditorRef.current?.getMarkdown?.() ?? editBody).trim();
          if (!nextBody) return;
          setEditSaving(true);
          try {
            await onUpdate(comment.id, nextBody);
            handleCancelEdit();
          } finally {
            setEditSaving(false);
          }
        };
        const handleDelete = async () => {
          if (!onDelete) return;
          const confirmed = await confirm({
            title: "Delete this comment?",
            description: "The original text will no longer be visible.",
            confirmLabel: "Delete",
            tone: "destructive",
          });
          if (!confirmed) return;
          await onDelete(comment.id);
        };
        const authorNode = comment.authorAgentId ? (
          <Link
            to={`/agents/${comment.authorAgentId}`}
            className={commentCollapsed ? "block min-w-0 max-w-full overflow-hidden hover:underline" : "min-w-0 hover:underline"}
          >
            <AgentIdentity
              name={agentMap?.get(comment.authorAgentId)?.name ?? comment.authorAgentId.slice(0, 8)}
              icon={agentMap?.get(comment.authorAgentId)?.icon}
              role={agentMap?.get(comment.authorAgentId)?.role}
              size="sm"
              className={commentCollapsed ? "max-w-full min-w-0 overflow-hidden" : undefined}
            />
          </Link>
        ) : (
          <Identity
            name={resolveOperatorDisplayName(operatorDisplayName)}
            size="sm"
            className={commentCollapsed ? "max-w-full min-w-0 overflow-hidden" : undefined}
          />
        );
        const timestampNode = (
          <a
            href={`#comment-${comment.id}`}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
            title={commentTimestampTitle}
            aria-label={`Comment posted ${commentTimestampTitle}`}
          >
            <time dateTime={timelineDateTime(comment.createdAt)}>
              {relativeTime(comment.createdAt)}
            </time>
          </a>
        );
        return (
          <div
            id={`comment-${comment.id}`}
            aria-label={commentCollapsed ? "Collapsed comment" : undefined}
            className={
              isEditing
                ? `overflow-hidden min-w-0 rounded-[var(--radius-lg)] border px-4 py-3 shadow-[var(--shadow-sm)] transition-colors duration-1000 ${isHighlighted ? "border-primary/50 bg-primary/5" : "border-border/80 bg-card/80"}`
                : `border overflow-hidden min-w-0 rounded-sm transition-colors duration-1000 ${commentCollapsed ? "border-dashed bg-muted/35 px-3 py-1 hover:bg-muted/50" : "p-3"} ${isHighlighted ? "border-primary/50 bg-primary/5" : "border-border"}`
            }
          >
            {isEditing ? (
              <div className="mb-3 flex min-w-0 items-center gap-2">
                <div className="min-w-0">{authorNode}</div>
                <span className="shrink-0 text-sm text-muted-foreground">{relativeTime(comment.createdAt)}</span>
                {isEdited ? (
                  <span className="shrink-0 text-xs text-muted-foreground" title={formatDateTime(comment.updatedAt)}>
                    edited
                  </span>
                ) : null}
              </div>
            ) : (
              <div
                data-comment-collapsed-header={commentCollapsed ? "true" : undefined}
                className={commentCollapsed
                  ? "grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-xs"
                  : "grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-3"}
              >
                <div className={commentCollapsed ? "min-w-0 py-1" : "min-w-0"}>
                  <span className={commentCollapsed ? "block min-w-0 max-w-[min(24rem,55vw)]" : "min-w-0"}>{authorNode}</span>
                  {commentCollapsed && commentPreview ? (
                    <span
                      className="mt-1 block min-w-0 break-words line-clamp-2 text-sm leading-5 text-foreground"
                      title={commentPreview}
                    >
                      {commentPreview}
                    </span>
                  ) : null}
                </div>
                <span className={commentCollapsed ? "hidden h-7 shrink-0 items-center sm:inline-flex" : "flex h-7 shrink-0 items-center gap-1.5"}>
                  {timestampNode}
                  {isEdited ? (
                    <span className="text-xs text-muted-foreground" title={formatDateTime(comment.updatedAt)}>
                      edited
                    </span>
                  ) : null}
                </span>
                <span className={commentCollapsed ? "flex h-7 shrink-0 items-center gap-1" : "flex h-7 shrink-0 items-center gap-1"}>
                  {commentCollapsed ? (
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-background/70 text-muted-foreground motion-safe:transition-[background-color,color,transform] hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
                      aria-label="Expand comment"
                      aria-expanded="false"
                      title="Expand comment"
                      onClick={handleToggleCollapsed}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {!commentCollapsed ? (
                    <CommentActionsMenu
                      comment={comment}
                      orgId={orgId}
                      projectId={projectId}
                      location={location}
                      collapsed={commentCollapsed}
                      canEdit={canEdit}
                      canDelete={canDelete}
                      onToggleCollapsed={handleToggleCollapsed}
                      onEdit={handleStartEdit}
                      onDelete={handleDelete}
                    />
                  ) : null}
                </span>
              </div>
            )}
            {isEditing ? (
              <>
                <MarkdownEditor
                  ref={editEditorRef}
                  engine="milkdown"
                  value={editBody}
                  onChange={setEditBody}
                  placeholder="Edit comment..."
                  mentions={mentions}
                  agentMentionIntent="wake"
                  imageUploadHandler={imageUploadHandler}
                  className="rounded-[var(--radius-md)] bg-transparent"
                  contentClassName="min-h-[92px] bg-transparent text-[15px] leading-7 text-foreground"
                  bordered={false}
                  onSubmit={handleSaveEdit}
                />
                <div className="mt-5 flex items-center justify-between gap-3">
                  {imageUploadHandler ? (
                    <div>
                      <input
                        ref={editAttachInputRef}
                        type="file"
                        accept={COMMENT_ATTACHMENT_ACCEPT}
                        multiple
                        className="hidden"
                        onChange={handleEditAttachFile}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => editAttachInputRef.current?.click()}
                        disabled={editAttaching || editSaving}
                        title="Attach file"
                      >
                        <Paperclip className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={handleCancelEdit} disabled={editSaving}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleSaveEdit} disabled={editSaving || editAttaching || !editBody.trim()}>
                      {editSaving ? "Saving..." : "Save"}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <AnimatedCommentBody collapsed={commentCollapsed}>
                <MarkdownBody
                  className="text-sm"
                  agentMentions={agentMentions}
                  skillReferences={skillReferences}
                  onLinkClick={onMarkdownLinkClick}
                >
                  {comment.body}
                </MarkdownBody>
                {comment.runId ? (
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
                ) : null}
              </AnimatedCommentBody>
            )}
          </div>
        );
      };
  return (
    <CommentThreadTimelineRows
      announcement={disclosureAnnouncement}
      mountAll={mountAll}
      onTargetMounted={onTargetMounted}
      reserveHashScrollEndSpace={reserveHashScrollEndSpace}
      regionLabel={timelineRegionLabel}
      scrollElementRef={scrollElementRef}
      targetKey={highlightCommentId ? `comment:${highlightCommentId}` : null}
      timeline={timeline}
      timelineRegionId={timelineRegionId}
    >
      {(item) => renderTimelineItem(item)}
    </CommentThreadTimelineRows>
  );
});

export function CommentThread({
  comments,
  linkedRuns = [],
  activityItems = [],
  orgId,
  projectId,
  onAdd,
  onUpdate,
  onDelete,
  currentUserId,
  issueStatus,
  locale = "en",
  reopenWillWakeAgent = false,
  steerRunId = null,
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
  fixedComposer = false,
  fixedComposerTimelineScroll = true,
  composerReplacement,
  timelineScrollElementRef,
  progressiveDisclosure,
}: CommentThreadProps) {
  const [body, setBody] = useState(() => draftKey ? loadDraft(draftKey) : "");
  const canReopen = shouldOfferReopen(issueStatus);
  const [reopen, setReopen] = useState(canReopen);
  const [attaching, setAttaching] = useState(false);
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const [runExpandedOverrides, setRunExpandedOverrides] = useState<Record<string, boolean>>({});
  const [reserveHashScrollEndSpace, setReserveHashScrollEndSpace] = useState(false);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const composerSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [composerEditorScrollElement, setComposerEditorScrollElement] = useState<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const internalTimelineScrollRef = useRef<HTMLDivElement | null>(null);
  const activeTimelineScrollRef = timelineScrollElementRef
    ?? (fixedComposer && fixedComposerTimelineScroll ? internalTimelineScrollRef : undefined);
  const location = useLocation();
  const navigate = useNavigate();
  const lastHandledCommentHashRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScrollAnimationFramesRef = useRef<number[]>([]);
  const pendingScrollRetryTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const lastCommentScrollRef = useRef<{ container: HTMLElement | null; scrollTop: number | null } | null>(null);
  const pendingScrollCancelCleanupRef = useRef<(() => void) | null>(null);
  const visibleComments = useMemo(() => comments.filter((comment) => !comment.deletedAt), [comments]);
  const currentIssueId = visibleComments[0]?.issueId ?? null;
  const commentPlaceholder = translateLegacyString(locale, "Leave a comment...");

  useEffect(() => {
    const scrollElement = composerEditorScrollElement;
    if (!scrollElement || typeof ResizeObserver === "undefined") return;

    let animationFrame: number | null = null;
    let observedContent: HTMLElement | null = null;

    const syncHeight = () => {
      if (!observedContent) return;
      const maxHeight = Math.min(
        window.innerHeight * MOBILE_COMMENT_COMPOSER_MAX_VIEWPORT_RATIO,
        MOBILE_COMMENT_COMPOSER_MAX_HEIGHT_PX,
      );
      const nextHeight = Math.max(
        MOBILE_COMMENT_COMPOSER_MIN_HEIGHT_PX,
        Math.min(Math.ceil(observedContent.scrollHeight), maxHeight),
      );
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        scrollElement.style.setProperty("--comment-composer-editor-height", `${nextHeight}px`);
        animationFrame = null;
      });
    };

    const resizeObserver = new ResizeObserver(syncHeight);
    const observeEditorContent = () => {
      const nextContent = scrollElement.querySelector<HTMLElement>(
        ".rudder-milkdown-content, .rudder-mdxeditor-content, .rudder-codemirror-markdown-content",
      );
      if (nextContent === observedContent) return;
      resizeObserver.disconnect();
      observedContent = nextContent;
      if (observedContent) {
        resizeObserver.observe(observedContent);
        syncHeight();
      }
    };

    const mutationObserver = new MutationObserver(observeEditorContent);
    mutationObserver.observe(scrollElement, { childList: true, subtree: true });
    window.addEventListener("resize", syncHeight, { passive: true });
    observeEditorContent();

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncHeight);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    };
  }, [composerEditorScrollElement]);

  const timeline = useMemo(() => buildCommentThreadTimeline({
    activityItems,
    comments: visibleComments,
    linkedRuns,
  }), [activityItems, linkedRuns, visibleComments]);
  const disclosureItems = useMemo(
    () => toIssueTimelineDisclosureItems(timeline),
    [timeline],
  );
  const timelineDisclosure = useIssueTimelineDisclosure({
    config: progressiveDisclosure,
    items: disclosureItems,
    locale,
  });
  const visibleTimeline = useMemo(
    () => projectCommentThreadTimeline(timeline, timelineDisclosure.selection),
    [timeline, timelineDisclosure.selection],
  );

  const transcriptRuns = useMemo(
    () => commentThreadTranscriptRuns(linkedRuns, agentMap),
    [agentMap, linkedRuns],
  );

  const hydratedTranscriptRuns = useMemo(() => (
    transcriptRuns.filter((run) =>
      shouldExpandRunByDefault(run.status) || runExpandedOverrides[run.id] === true)
  ), [runExpandedOverrides, transcriptRuns]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: hydratedTranscriptRuns,
    orgId,
    maxChunksPerRun: 120,
  });

  const toggleRunExpanded = useCallback((runId: string, expanded: boolean) => {
    setRunExpandedOverrides((current) => ({
      ...current,
      [runId]: expanded,
    }));
  }, []);

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

  const updateBody = useCallback((nextBody: string) => {
    setBody(nextBody);
    if (draftKey) saveDraft(draftKey, nextBody);
  }, [draftKey]);
  const { canSubmit, handleSubmit, submitting } = useCommentSubmit({
    agentMap,
    body,
    canReopen,
    composerSurfaceRef,
    draftKey,
    editorRef,
    locale,
    onAdd,
    reopen,
    reopenWillWakeAgent,
    setReopen,
    updateBody,
  });

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

  const clearPendingCommentScroll = useCallback(() => {
    if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
      for (const frame of pendingScrollAnimationFramesRef.current) {
        window.cancelAnimationFrame(frame);
      }
    }
    pendingScrollAnimationFramesRef.current = [];
    for (const timer of pendingScrollRetryTimersRef.current) {
      clearTimeout(timer);
    }
    pendingScrollRetryTimersRef.current = [];
    pendingScrollCancelCleanupRef.current?.();
    pendingScrollCancelCleanupRef.current = null;
    lastCommentScrollRef.current = null;
    setReserveHashScrollEndSpace(false);
  }, []);

  useEffect(() => {
    return () => {
      clearPendingCommentScroll();
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, [clearPendingCommentScroll]);

  useEffect(() => {
    setReopen(canReopen);
  }, [canReopen]);

  const scrollToComment = useCallback((commentId: string, behavior: ScrollBehavior = "smooth", options: { retry?: boolean } = {}) => {
    const el = document.getElementById(`comment-${commentId}`);
    if (!el) return false;

    if (options.retry && measureCommentCenterDelta(el) <= COMMENT_SCROLL_CENTER_TOLERANCE_PX) {
      clearPendingCommentScroll();
      return true;
    }

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightCommentId(commentId);
    const result = scrollCommentElementToCenter(el, behavior);
    lastCommentScrollRef.current = {
      container: result.container,
      scrollTop: result.scrollTop,
    };
    rememberMainScrollTopForPath(location.pathname, result.scrollTop);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightCommentId(null);
      highlightTimerRef.current = null;
    }, 3000);
    return true;
  }, [clearPendingCommentScroll, location.pathname]);

  const handleMarkdownLinkClick = useCallback<MarkdownLinkClickHandler>(({ event, href }) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      typeof window === "undefined"
    ) {
      return;
    }

    const commentId = resolveCurrentIssueCommentLink({
      href,
      baseHref: window.location.href,
      currentPathname: location.pathname,
      currentIssueId,
      currentIssueRef: extractIssueRouteRef(location),
    });
    if (commentId) {
      event.preventDefault();
      event.stopPropagation();

      const hash = `#comment-${encodeURIComponent(commentId)}`;
      if (location.hash === hash) {
        scrollToComment(commentId);
      } else {
        navigate({ pathname: location.pathname, search: location.search, hash });
      }
      return true;
    }

    const sameIssueCommentId = (() => {
      try {
        const target = new URL(href, window.location.href);
        if (target.origin !== window.location.origin) return null;
        if (target.hash === location.hash) return null;
        const targetCommentId = commentIdFromIssueCommentHash(target.hash);
        if (!targetCommentId) return null;
        const targetIssueRef = extractIssueRouteRefFromPathname(target.pathname);
        if (!targetIssueRef) return null;
        const currentIssueRef = extractIssueRouteRef(location);
        if (currentIssueRef && targetIssueRef === currentIssueRef) return targetCommentId;
        if (currentIssueId && targetIssueRef === currentIssueId) return targetCommentId;
        return null;
      } catch {
        return null;
      }
    })();
    if (sameIssueCommentId) {
      event.preventDefault();
      event.stopPropagation();
      navigate({
        pathname: location.pathname,
        search: location.search,
        hash: `#comment-${encodeURIComponent(sameIssueCommentId)}`,
      });
      return true;
    }

    const route = resolveInternalMarkdownRoute({
      href,
      baseHref: window.location.href,
    });
    if (!route) return;

    event.preventDefault();
    event.stopPropagation();
    navigate(route);
    return true;
  }, [currentIssueId, location, navigate, scrollToComment]);

  useLayoutEffect(() => {
    const commentId = commentIdFromIssueCommentHash(location.hash);
    if (!commentId) return;
    timelineDisclosure.revealTarget(`comment:${commentId}`);
  }, [location.hash, timelineDisclosure.revealTarget]);

  useEffect(() => {
    const hash = location.hash;
    const commentId = commentIdFromIssueCommentHash(hash);
    if (!commentId || visibleComments.length === 0) return;
    if (!visibleComments.some((comment) => comment.id === commentId)) return;
    const navigationKey = `${location.key}:${hash}`;
    if (lastHandledCommentHashRef.current === navigationKey) return;
    clearPendingCommentScroll();
    setReserveHashScrollEndSpace(true);

    if (scrollToComment(commentId, "auto")) {
      lastHandledCommentHashRef.current = navigationKey;
      const cancelTarget = lastCommentScrollRef.current?.container ?? window;
      const cancelPendingScroll = () => {
        clearPendingCommentScroll();
      };
      for (const eventName of COMMENT_HASH_SCROLL_CANCEL_EVENTS) {
        cancelTarget.addEventListener(eventName, cancelPendingScroll, { passive: true });
      }
      pendingScrollCancelCleanupRef.current = () => {
        for (const eventName of COMMENT_HASH_SCROLL_CANCEL_EVENTS) {
          cancelTarget.removeEventListener(eventName, cancelPendingScroll);
        }
      };
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        const firstFrame = window.requestAnimationFrame(() => {
          const secondFrame = window.requestAnimationFrame(() => {
            scrollToComment(commentId, "auto", { retry: true });
            pendingScrollAnimationFramesRef.current = pendingScrollAnimationFramesRef.current.filter((frame) => frame !== secondFrame);
          });
          pendingScrollAnimationFramesRef.current.push(secondFrame);
          pendingScrollAnimationFramesRef.current = pendingScrollAnimationFramesRef.current.filter((frame) => frame !== firstFrame);
        });
        pendingScrollAnimationFramesRef.current.push(firstFrame);
      }
      for (const delay of COMMENT_HASH_SCROLL_RETRY_DELAYS_MS) {
        const timer = setTimeout(() => {
          scrollToComment(commentId, "auto", { retry: true });
          pendingScrollRetryTimersRef.current = pendingScrollRetryTimersRef.current.filter((item) => item !== timer);
        }, delay);
        pendingScrollRetryTimersRef.current.push(timer);
      }
      const clearSpacerTimer = setTimeout(() => {
        setReserveHashScrollEndSpace(false);
        pendingScrollRetryTimersRef.current = pendingScrollRetryTimersRef.current.filter((item) => item !== clearSpacerTimer);
      }, Math.max(...COMMENT_HASH_SCROLL_RETRY_DELAYS_MS) + 120);
      pendingScrollRetryTimersRef.current.push(clearSpacerTimer);
    } else {
      setHighlightCommentId(commentId);
    }
  }, [clearPendingCommentScroll, location.hash, location.key, scrollToComment, visibleComments]);

  const handleTargetMounted = useCallback((key: string) => {
    if (!key.startsWith("comment:")) return;
    const navigationKey = `${location.key}:${location.hash}`;
    if (lastHandledCommentHashRef.current === navigationKey) return;
    const commentId = key.slice("comment:".length);
    if (!commentId || !scrollToComment(commentId, "auto")) return;
    lastHandledCommentHashRef.current = navigationKey;
    setReserveHashScrollEndSpace(false);
  }, [location.hash, location.key, scrollToComment]);

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(evt.target.files ?? []);
    if (files.length === 0) return;
    setAttaching(true);
    try {
      if (imageUploadHandler) {
        const snippets: string[] = [];
        for (const file of files) {
          const url = await imageUploadHandler(file);
          const safeName = file.name.replace(/[[\]]/g, "\\$&");
          snippets.push(file.type.startsWith("image/")
            ? `![${safeName}](${url})`
            : `[${safeName}](${url})`);
        }
        const markdown = snippets.join("\n\n");
        setBody((prev) => {
          const nextBody = prev ? `${prev}\n\n${markdown}` : markdown;
          if (draftKey) saveDraft(draftKey, nextBody);
          return nextBody;
        });
      } else if (onAttachImage) {
        for (const file of files) {
          await onAttachImage(file);
        }
      }
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  const focusComposerEditor = (event: MouseEvent<HTMLDivElement>) => {
    if (!shouldForwardComposerFocus(event.target)) return;
    event.preventDefault();
    editorRef.current?.focus();
  };

  const timelineNode = (
    <TimelineList
      timeline={visibleTimeline}
      agentMap={agentMap}
      orgId={orgId}
      projectId={projectId}
      highlightCommentId={highlightCommentId}
      runExpandedOverrides={runExpandedOverrides}
      onToggleRunExpanded={toggleRunExpanded}
      runTranscriptById={transcriptByRun}
      runHasOutput={hasOutputForRun}
      operatorDisplayName={operatorDisplayName}
      agentMentions={agentMentions}
      skillReferences={skillReferences}
      mentions={mentions}
      emptyMessage={emptyMessage}
      currentUserId={currentUserId}
      onUpdate={onUpdate}
      onDelete={onDelete}
      imageUploadHandler={imageUploadHandler}
      onMarkdownLinkClick={handleMarkdownLinkClick}
      reserveHashScrollEndSpace={reserveHashScrollEndSpace}
      timelineRegionLabel={progressiveDisclosure
        ? (locale === "zh-CN" ? "任务动态时间线" : "Issue activity timeline")
        : undefined}
      scrollElementRef={activeTimelineScrollRef}
      onTargetMounted={handleTargetMounted}
      mountAll={timelineDisclosure.mountAll}
      onRevealMore={timelineDisclosure.revealMore}
      timelineRegionId={timelineDisclosure.timelineRegionId}
      disclosureAnnouncement={timelineDisclosure.announcement}
      locale={locale}
    />
  );

  const composerNode = (
    <div
      ref={composerSurfaceRef}
      aria-label="Comment composer"
      className="chat-composer grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-end gap-x-1.5 rounded-[var(--radius-lg)] p-2 md:block md:p-3"
      data-composer-state={body.trim() ? "composing" : "empty"}
      data-issue-detail-escape-back={escapeBackWhenEmpty ? (body.trim() ? "dirty" : "empty") : undefined}
      onMouseDown={focusComposerEditor}
      tabIndex={-1}
    >
      <div
        ref={setComposerEditorScrollElement}
        data-testid="issue-comment-composer-editor-scroll"
        className="motion-comment-composer-height scrollbar-auto-hide relative col-start-2 row-start-1 h-[var(--comment-composer-editor-height)] min-w-0 max-h-[min(24dvh,10rem)] overflow-y-auto overscroll-contain pr-1 md:h-auto md:max-h-[min(38dvh,22rem)]"
        style={{ "--comment-composer-editor-height": "1.875rem" } as CSSProperties}
      >
        {!body.trim() ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-start pt-px text-sm text-muted-foreground md:hidden"
          >
            {commentPlaceholder}
          </span>
        ) : null}
        <MarkdownEditor
          ref={editorRef}
          engine="milkdown"
          value={body}
          onChange={updateBody}
          placeholder={commentPlaceholder}
          mentions={mentions}
          agentMentionIntent="wake"
          onMentionQueryChange={onMentionQueryChange}
          mentionMenuAnchorRef={composerSurfaceRef}
          mentionMenuPlacement="container"
          onSubmit={() => handleSubmit()}
          imageUploadHandler={imageUploadHandler}
          className="rounded-[var(--radius-md)] bg-transparent"
          contentClassName="min-h-7 bg-transparent text-sm leading-6 text-foreground md:min-h-16"
          bordered={false}
        />
      </div>
      <div className="contents md:mt-3 md:flex md:items-center md:justify-end md:gap-3">
        {(imageUploadHandler || onAttachImage) && (
          <div className="col-start-1 row-start-1 flex items-center self-end md:mr-auto md:gap-3">
            <input
              ref={attachInputRef}
              type="file"
              accept={COMMENT_ATTACHMENT_ACCEPT}
              multiple
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
          <label className="col-span-3 row-start-2 mt-2 flex cursor-pointer select-none items-center gap-1.5 justify-self-end text-xs text-muted-foreground md:mt-0">
            <input
              type="checkbox"
              checked={reopen}
              onChange={(e) => setReopen(e.target.checked)}
              className="rounded border-border"
            />
            Re-open
          </label>
        ) : null}
        <div className="col-start-3 row-start-1 flex items-center gap-1.5 self-end">
          {steerRunId ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="issue-comment-steer"
              disabled={!canSubmit}
              onClick={() => handleSubmit("steer")}
              title="Interrupt the active run and continue with this feedback"
            >
              <CornerDownRight className="mr-1.5 h-3.5 w-3.5" />
              Steer
            </Button>
          ) : null}
          <Button size="sm" disabled={!canSubmit} onClick={() => handleSubmit()}>
            {submitting ? "Posting..." : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  );
  const activeComposerNode = composerReplacement ?? composerNode;

  if (fixedComposer) {
    if (!fixedComposerTimelineScroll) {
      return (
        <div className="flex min-h-0 flex-col gap-1">
          {!hideHeading && (
            <div className="shrink-0">
              {heading ?? <h3 className="text-sm font-semibold">Comments &amp; Runs ({timeline.length})</h3>}
            </div>
          )}

          <div data-testid="comment-thread-timeline-flow">
            {timelineNode}
            {liveRunSlot ? <div className="mt-3">{liveRunSlot}</div> : null}
          </div>

          <div
            className="comment-thread-fixed-composer sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 -mx-4 shrink-0 px-4 pb-4 pt-1 md:bottom-0"
            data-testid="comment-thread-fixed-composer"
          >
            {activeComposerNode}
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {!hideHeading && (
          <div className="shrink-0">
            {heading ?? <h3 className="text-sm font-semibold">Comments &amp; Runs ({timeline.length})</h3>}
          </div>
        )}

        <div
          ref={internalTimelineScrollRef}
          className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
          data-testid="comment-thread-timeline-scroll"
        >
          {timelineNode}
          {liveRunSlot ? <div className="mt-4">{liveRunSlot}</div> : null}
        </div>

        <div
          className="comment-thread-fixed-composer sticky bottom-0 z-20 -mx-4 -mb-4 shrink-0 px-4 pb-4 pt-3"
          data-testid="comment-thread-fixed-composer"
        >
          {activeComposerNode}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!hideHeading && (
        heading ?? <h3 className="text-sm font-semibold">Comments &amp; Runs ({timeline.length})</h3>
      )}

      {timelineNode}

      {liveRunSlot}

      {activeComposerNode}
    </div>
  );
}

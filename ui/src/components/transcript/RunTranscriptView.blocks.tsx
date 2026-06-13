import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptEntry } from "../../agent-runtimes";
import { MarkdownBody, type MarkdownLinkClickHandler } from "../MarkdownBody";
import { cn, formatTokens } from "../../lib/utils";
import { readDesktopShell } from "../../lib/desktop-shell";
import { stripBenignStderr } from "../../lib/benign-stderr";
import {
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FileDiff,
  FileSearch,
  FileText,
  FolderOpen,
  Globe,
  ListTree,
  Loader2,
  Logs,
  Plug,
  Search,
  TerminalSquare,
  User,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TranscriptMode, TranscriptDensity, TranscriptPresentation, TranscriptToolCategory, TranscriptDigestBucket, TranscriptActionIconCategory, TranscriptActionIconStatus, TranscriptActionIconTreatment, TranscriptToolSemanticInfo, TranscriptToolCardEntry, TranscriptMemoryScope, TranscriptMemoryUpdateChange, TranscriptTodoListItem, RunTranscriptViewProps, TranscriptBlock, ChatTranscriptTurn, ChatTranscriptAction, COMMON_FILENAME_TOKENS, STRONG_WRITE_COMMAND_TOKENS, LONG_EVENT_COLLAPSE_CHARS, LONG_EVENT_COLLAPSE_LINES, LOCAL_POSIX_FILE_ROOTS, TranscriptMarkdownLinkClickHandler, asRecord, decodeFileUrlPath, resolveTranscriptLocalFileTarget, shouldHandlePlainClick, compactWhitespace, isTurnStartedText, isRudderDeveloperDiagnosticLine, isRudderDeveloperDiagnosticContinuationLine, filterRoutineStdout, isWarningStderrLine, isAnalyticsForbiddenHtmlStart, filterRenderableTranscriptEntries, shouldCollapseEventText, formatTranscriptTimestamp, getTranscriptActionIconTreatment, getTranscriptActionIconTone, TranscriptActionIcon, TranscriptActionIconSlot, TranscriptActionIconStack, getTranscriptTimestampTitle, formatTranscriptDuration, truncate, pluralize, humanizeLabel } from "./RunTranscriptView.common";
import { decodeShellEscapes, stripWrappedShell, tokenizeShellForClassification, shellTokensForCommand, isShellControlToken, commandSegmentFrom, splitShellCommandSegments, hasHelpSignal, hasStdoutWriteRedirect, extractStdoutWriteRedirectTarget, extractStdoutWriteRedirectTargetFromTokens, commandSegmentHasStdoutWriteRedirect, commandUsesInPlaceSed, commandUsesInPlacePerl, isPackageInstallCommand, commandSegmentUsesInPlaceSed, commandSegmentUsesInPlacePerl, findStrongEditSegment, hasPackageInstallSegment, getShellPositionalArgsFromTokens, classifyShellCommand, unwrapQuotedToken, cleanShellToken, normalizeTranscriptPathToken, titleCaseAgentSlug, inferAgentNameFromMemoryPath, classifyAgentMemoryPath, formatMemoryScopeLabel, formatMemoryScopeSummary, formatMemoryEffect, formatMemoryOperation, splitFileChangeEntries, extractMemoryUpdateFailureReason, parseMemoryUpdateSystemText, tokenizeShell } from "./RunTranscriptView.shell";
import { normalizePathTarget, dedupeTargets, extractSkillSlugFromEntryPath, extractSkillSlugsFromEntryPaths, formatSkillUseAction, isLikelyPathToken, isLikelySedExpressionToken, getShellPositionalArgs, extractRecordPaths, extractRecordQuery, readStringField, extractQueryValues, extractWebSearchQueries, isWebSearchTool, formatWebSearchSummary, McpToolDetails, MCP_METADATA_KEYS, parseMcpToolName, sanitizeMcpArgs, extractMcpToolDetails, summarizeMcpValue, summarizeMcpArgs, formatMcpLabel, formatMcpSummary, formatTargetAction, quoteSummaryText, formatSearchActionSummary, summarizeCommandPhrase, extractShellFlagValue, formatRudderTarget, summarizeIssueComment, describeRudderCommandSemanticInfo, describeCommandSemanticInfo, formatUnknown, formatToolPayload, extractToolUseId, describeToolInvocation, summarizeRecord, summarizeToolInput, parseStructuredToolResult, formatCommandTerminalOutput, isCommandTool, describeToolSemanticInfo } from "./RunTranscriptView.semantic";
import { formatSemanticDigest, summarizeToolResult, parseSystemActivity, getTodoListCompletedCount, formatTodoListSummary, formatTodoListRaw, shouldHideNiceModeStderr, groupCommandBlocks, segmentTranscriptEntriesByTurn, normalizeTranscript, summarizeChatTurn, normalizeChatTranscriptTurns } from "./RunTranscriptView.normalize";

async function writeTranscriptClipboardText(text: string) {
  const desktopShell = readDesktopShell();
  if (desktopShell?.copyText) {
    await desktopShell.copyText(text);
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard write failed.");
}

function formatCommandCopyText(command: string, output: string | null) {
  return output ? `${command}\n\n${output}` : command;
}

export function TranscriptMessageBlock({
  block,
  density,
  presentation = "default",
  className,
  collapsibleSummary = false,
  onMarkdownLinkClick,
}: {
  block: Extract<TranscriptBlock, { type: "message" }>;
  density: TranscriptDensity;
  presentation?: TranscriptPresentation;
  className?: string;
  collapsibleSummary?: boolean;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
}) {
  const compact = density === "compact";
  const isUser = block.role === "user";
  const showRoleLabel = isUser && presentation !== "detail";
  const [open, setOpen] = useState(true);

  const body = (
    <MarkdownBody
      className={cn(
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        compact
          ? "text-xs leading-5 text-foreground/85"
          : presentation === "detail"
            ? "text-sm leading-7"
            : "text-sm",
        className,
      )}
      onLinkClick={onMarkdownLinkClick}
    >
      {block.text}
    </MarkdownBody>
  );

  if (!isUser || !collapsibleSummary) {
    return (
      <div title={getTranscriptTimestampTitle(block.ts)}>
        {showRoleLabel && (
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
            <User className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
            <span>User</span>
          </div>
        )}
        {body}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/30 bg-muted/10" title={getTranscriptTimestampTitle(block.ts)}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse user message" : "Expand user message"}
      >
        <DisclosureChevron open={open} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
          <User className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          <span>User</span>
        </div>
      </button>
      {open && <div className="motion-disclosure-enter border-t border-border/20 px-2.5 pb-2.5 pt-2">{body}</div>}
    </div>
  );
}

export function TranscriptThinkingBlock({
  block,
  density,
  className,
  collapsibleSummary = false,
  onMarkdownLinkClick,
}: {
  block: Extract<TranscriptBlock, { type: "thinking" }>;
  density: TranscriptDensity;
  className?: string;
  collapsibleSummary?: boolean;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
}) {
  const [open, setOpen] = useState(() => Boolean(block.streaming));

  useEffect(() => {
    if (block.streaming) {
      setOpen(true);
    }
  }, [block.streaming]);

  const previewSource = compactWhitespace(block.text);
  const preview = truncate(previewSource, density === "compact" ? 100 : 160);

  const body = (
    <MarkdownBody
      className={cn(
        "italic text-foreground/75 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        density === "compact" ? "text-[11px] leading-5" : "text-sm leading-6",
        className,
      )}
      onLinkClick={onMarkdownLinkClick}
    >
      {block.text}
    </MarkdownBody>
  );

  if (!collapsibleSummary) {
    return body;
  }

  return (
    <div className="rounded-lg border border-border/30 bg-muted/10" title={getTranscriptTimestampTitle(block.ts)}>
      <button
        type="button"
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse thinking" : "Expand thinking"}
      >
        {block.streaming ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <DisclosureChevron open={open} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground">Thinking</div>
          {!open && !block.streaming ? (
            <div className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-foreground/55">{preview || "…"}</div>
          ) : null}
        </div>
      </button>
      {(open || block.streaming) && (
        <div className="motion-disclosure-enter border-t border-border/20 px-2.5 pb-2.5 pt-2">{body}</div>
      )}
    </div>
  );
}

export function renderTranscriptBlock({
  block,
  index,
  density,
  presentation,
  collapseStdout,
  thinkingClassName,
  onMarkdownLinkClick,
}: {
  block: TranscriptBlock;
  index: number;
  density: TranscriptDensity;
  presentation: TranscriptPresentation;
  collapseStdout: boolean;
  thinkingClassName?: string;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
}) {
  return (
    <div
      key={`${block.type}-${block.ts}-${index}`}
      className={cn(index === -1 && "hidden")}
    >
      {block.type === "message" && (
        <TranscriptMessageBlock
          block={block}
          density={density}
          presentation={presentation}
          collapsibleSummary={presentation === "chat"}
          onMarkdownLinkClick={onMarkdownLinkClick}
        />
      )}
      {block.type === "thinking" && (
        <TranscriptThinkingBlock
          block={block}
          density={density}
          className={thinkingClassName}
          onMarkdownLinkClick={onMarkdownLinkClick}
        />
      )}
      {block.type === "tool" && <TranscriptToolCard block={block} density={density} presentation={presentation} />}
      {block.type === "command_group" && <TranscriptCommandGroup block={block} density={density} />}
      {block.type === "todo_list" && <TranscriptTodoListRow block={block} density={density} presentation={presentation} />}
      {block.type === "stdout" && (
        <TranscriptStdoutRow
          block={block}
          density={density}
          collapseByDefault={collapseStdout}
          presentation={presentation}
        />
      )}
      {block.type === "memory_update" && <TranscriptMemoryUpdateRow block={block} density={density} />}
      {block.type === "activity" && <TranscriptActivityRow block={block} density={density} />}
      {block.type === "event" && (
        <TranscriptEventRow block={block} density={density} presentation={presentation} />
      )}
    </div>
  );
}

export function CommandTerminalDetail({
  command,
  output,
  status,
  className,
}: {
  command: string;
  output: string | null;
  status: TranscriptToolCardEntry["status"];
  className?: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copyLabel =
    copyState === "copied" ? "Copied command output" : copyState === "failed" ? "Copy failed" : "Copy command output";
  const copyText = useMemo(() => formatCommandCopyText(command, output), [command, output]);

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  const handleCopy = useCallback(async () => {
    clearTimeout(resetTimerRef.current);
    try {
      await writeTranscriptClipboardText(copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), 1600);
  }, [copyText]);

  return (
    <div
      data-testid="command-terminal-detail"
      className={cn(
        "group/command-terminal relative overflow-hidden rounded-xl border border-neutral-800 bg-[#0a0a0a] text-neutral-100 shadow-[0_18px_45px_-28px_rgb(0_0_0/0.75)]",
        className,
      )}
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-white/10 bg-[#171717] px-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
      </div>
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-[#242424]/90 text-neutral-300 opacity-0 shadow-sm transition-all hover:border-white/20 hover:bg-[#2f2f2f] hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 group-hover/command-terminal:opacity-100"
              aria-label={copyLabel}
              data-testid="command-terminal-copy-button"
              data-copy-state={copyState}
              onClick={() => void handleCopy()}
            >
              {copyState === "copied" ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={8}>
            {copyLabel}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div className="p-4 font-mono text-[11px] leading-5">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-neutral-100">
          <span className="select-none text-emerald-400">$ </span>
          {command}
        </pre>
        {output ? (
          <pre className={cn(
            "mt-3 overflow-x-auto whitespace-pre-wrap break-words",
            status === "error" ? "text-red-300" : "text-neutral-200",
          )}>
            {output}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function getToolCommand(block: TranscriptToolCardEntry): string | null {
  if (typeof block.input === "string" && isCommandTool(block.name, block.input)) {
    return stripWrappedShell(block.input);
  }
  const record = asRecord(block.input);
  if (record) {
    if (typeof record.command === "string") return stripWrappedShell(record.command);
    if (typeof record.cmd === "string") return stripWrappedShell(record.cmd);
  }
  return null;
}

export function TranscriptToolCard({
  block,
  density,
  presentation = "default",
}: {
  block: TranscriptToolCardEntry;
  density: TranscriptDensity;
  presentation?: TranscriptPresentation;
}) {
  const [open, setOpen] = useState(presentation !== "detail" && block.status === "error");
  const compact = density === "compact";
  const detail = presentation === "detail";
  const semantic = describeToolSemanticInfo(block.name, block.input);
  const isCommand = isCommandTool(block.name, block.input);
  const statusLabel =
    block.status === "running"
      ? "Running"
      : block.status === "error"
        ? "Errored"
        : isCommand
          ? null
          : "Completed";
  const statusTone =
    block.status === "running"
      ? "text-cyan-700 dark:text-cyan-300"
      : block.status === "error"
        ? "text-red-700 dark:text-red-300"
        : "text-emerald-700 dark:text-emerald-300";
  const duration = formatTranscriptDuration(block.ts, block.endTs);
  const command = getToolCommand(block);
  const requestText = command ?? (formatToolPayload(block.input) || "<empty>");
  const responseText = command
    ? formatCommandTerminalOutput(block.result)
    : block.result
      ? formatToolPayload(block.result)
      : "Waiting for result...";
  const detailsClass = cn(
    "space-y-3",
    block.status === "error" && "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3",
    detail && "rounded-xl border border-border/40 bg-background/60 p-3",
  );
  const summary = semantic.summary;
  const outerClass = cn(
    detail && "rounded-xl border border-border/60 bg-background/80 p-3 shadow-sm",
    block.status === "error" && "rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3",
  );

  return (
    <div className={outerClass} title={getTranscriptTimestampTitle(block.ts)}>
      <div className="flex items-start gap-2">
        <TranscriptActionIconSlot category={semantic.category} status={block.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
              {semantic.label}
            </span>
            {statusLabel ? (
              <span className={cn("text-[10px] font-semibold tracking-[0.05em]", statusTone)}>
                {statusLabel}
              </span>
            ) : null}
            {duration && (
              <span className="text-[10px] font-medium tracking-[0.04em] text-muted-foreground">
                {duration}
              </span>
            )}
          </div>
          <div className={cn("mt-1 break-words text-foreground/80", compact ? "text-xs" : "text-sm")}>
            {summary}
          </div>
        </div>
        <button
          type="button"
          className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${isCommand ? "command" : "tool"} details` : `Expand ${isCommand ? "command" : "tool"} details`}
        >
          <DisclosureChevron open={open} className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <div className="motion-disclosure-enter mt-3">
          {command ? (
            <CommandTerminalDetail command={requestText} output={responseText} status={block.status} />
          ) : (
            <div className={detailsClass}>
              <div className={cn("grid gap-3", compact ? "grid-cols-1" : "lg:grid-cols-2")}>
                <div>
                  <div className="mb-1 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
                    Request
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
                    {requestText}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
                    Response
                  </div>
                  <pre className={cn(
                    "overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]",
                    block.status === "error" ? "text-red-700 dark:text-red-300" : "text-foreground/80",
                  )}>
                    {responseText ?? "No response"}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function hasSelectedText() {
  if (typeof window === "undefined") return false;
  return (window.getSelection()?.toString().length ?? 0) > 0;
}

export function DisclosureChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      data-state={open ? "open" : "closed"}
      className={cn("motion-disclosure-icon", className)}
      aria-hidden
    />
  );
}

export function areAllToolEntriesErrored(entries: TranscriptToolCardEntry[]) {
  return entries.length > 0 && entries.every((entry) => entry.status === "error");
}

export function formatTranscriptLabel(label: string) {
  return label
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function TranscriptCommandGroup({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "command_group" }>;
  density: TranscriptDensity;
}) {
  const compact = density === "compact";
  const runningItem = [...block.items].reverse().find((item) => item.status === "running");
  const allToolsErrored = areAllToolEntriesErrored(block.items);
  const [open, setOpen] = useState(allToolsErrored);
  const isRunning = Boolean(runningItem);
  const showExpandedErrorState = open && allToolsErrored;
  const semanticItems = block.items.map((item) => describeToolSemanticInfo(item.name, item.input));
  const summary = formatSemanticDigest(semanticItems, 0, { preferDirectSummary: true });
  const visibleIcons = block.items.slice(0, 3).map((item, index) => {
    const semantic = semanticItems[index] ?? describeToolSemanticInfo(item.name, item.input);
    return {
      category: semantic.category,
      status: item.status === "error" ? "error" : item.status === "running" ? "running" : "completed",
    } satisfies { category: TranscriptActionIconCategory; status: TranscriptActionIconStatus };
  });

  return (
    <div className={cn(showExpandedErrorState && "rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3")} title={getTranscriptTimestampTitle(block.ts)}>
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-pointer items-start gap-2"
        onClick={() => {
          if (hasSelectedText()) return;
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
      >
        <TranscriptActionIconStack icons={visibleIcons} highlightError={showExpandedErrorState} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold leading-none tracking-[0.05em] text-muted-foreground/70">
            Command activity
          </div>
          <div className={cn("mt-1 break-words text-foreground/85", compact ? "text-xs" : "text-sm")}>
            {summary || (isRunning ? "Working with commands" : "Command details")}
          </div>
        </div>
        <button
          type="button"
          className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          aria-label={open ? "Collapse command details" : "Expand command details"}
        >
          <DisclosureChevron open={open} className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <div className={cn("motion-disclosure-enter mt-3 space-y-3", allToolsErrored && "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3")}>
          {block.items.map((item, index) => (
            <TranscriptToolCard
              key={`${item.ts}-${index}`}
              block={item}
              density={density}
              presentation="chat"
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TranscriptActivityRow({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "activity" }>;
  density: TranscriptDensity;
}) {
  return (
    <div className="flex items-start gap-2" title={getTranscriptTimestampTitle(block.ts)}>
      {block.status === "completed" ? (
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
      ) : (
        <span className="relative mt-1 flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
        </span>
      )}
      <div className={cn(
        "break-words text-foreground/80",
        density === "compact" ? "text-xs leading-5" : "text-sm leading-6",
      )}>
        {block.name}
      </div>
    </div>
  );
}

export function TranscriptTodoListRow({
  block,
  density,
  presentation = "default",
}: {
  block: Extract<TranscriptBlock, { type: "todo_list" }>;
  density: TranscriptDensity;
  presentation?: TranscriptPresentation;
}) {
  const compact = density === "compact";
  const completedCount = getTodoListCompletedCount(block.items);
  const running = block.items.some((item) => item.status === "in_progress");
  const allCompleted = block.items.length > 0 && completedCount === block.items.length;
  const detail = presentation === "detail";

  return (
    <div
      className={cn(
        "rounded-xl border border-border/45 bg-muted/10",
        detail ? "p-3" : compact ? "p-2.5" : "p-3",
      )}
      title={getTranscriptTimestampTitle(block.ts)}
    >
      <div className="flex items-center gap-2">
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-600 dark:text-cyan-300" />
        ) : allCompleted ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/55" />
        )}
        <div className="min-w-0 flex-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
          Todo List
        </div>
        <div className="text-[10px] font-medium tabular-nums text-muted-foreground">
          {completedCount}/{block.items.length}
        </div>
      </div>
      <ul className={cn("mt-2 space-y-1.5", compact ? "text-xs leading-5" : "text-sm leading-6")}>
        {block.items.map((item, index) => (
          <li key={`${item.status}-${index}-${item.text}`} className="flex items-start gap-2 text-foreground/82">
            <span
              className={cn(
                "mt-[0.35em] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                item.status === "completed"
                  ? "border-emerald-500/40 bg-emerald-500/[0.10] text-emerald-700 dark:text-emerald-300"
                  : item.status === "in_progress"
                    ? "border-cyan-500/40 bg-cyan-500/[0.10] text-cyan-700 dark:text-cyan-300"
                    : "border-border bg-background text-transparent",
              )}
            >
              {item.status === "completed" ? (
                <Check className="h-2.5 w-2.5" />
              ) : item.status === "in_progress" ? (
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full" />
              )}
            </span>
            <span className={cn("min-w-0 break-words", item.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40")}>
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TranscriptMemoryUpdateRow({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "memory_update" }>;
  density: TranscriptDensity;
}) {
  const [open, setOpen] = useState(block.status === "error" && Boolean(block.failureReason));
  const compact = density === "compact";
  const isError = block.status === "error";
  const title = isError ? "Memory update failed" : "Agent memory updated";
  const scopeLabel = formatMemoryScopeLabel(block.scope);
  const agentLabel = block.agentName ?? "Agent";
  const expandedState = open ? "expanded" : "collapsed";
  const ariaLabel = `${title}, ${agentLabel}, ${scopeLabel}, ${expandedState}`;
  const paths = block.changes.map((change) => change.path);
  const tags = [agentLabel, scopeLabel, block.effect];

  return (
    <div
      data-transcript-memory-update="true"
      className={cn(
        "rounded-lg border px-2.5 py-2",
        isError
          ? "border-red-500/20 bg-red-500/[0.04]"
          : "border-border/45 bg-muted/10",
      )}
      title={getTranscriptTimestampTitle(block.ts)}
    >
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-pointer items-start gap-2 text-left"
        onClick={() => {
          if (hasSelectedText()) return;
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <TranscriptActionIconSlot category="memory" status={isError ? "error" : "completed"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn(
              "font-semibold tracking-[0.05em]",
              compact ? "text-[11px]" : "text-xs",
              isError ? "text-red-700 dark:text-red-300" : "text-foreground/80",
            )}>
              {title}
            </span>
            <span className="hidden text-[10px] font-medium tabular-nums text-muted-foreground sm:inline">
              {formatTranscriptTimestamp(block.ts)}
            </span>
          </div>
          <div className={cn("mt-1 break-words text-foreground/82", compact ? "text-xs leading-5" : "text-sm leading-6")}>
            {isError && block.failureReason ? block.failureReason : block.summary}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex max-w-full items-center rounded-md border border-border/55 bg-background/65 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                <span className="truncate">{tag}</span>
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          aria-expanded={open}
          aria-label={open ? "Collapse memory update details" : "Expand memory update details"}
        >
          <DisclosureChevron open={open} className="h-4 w-4" />
        </button>
      </div>
      {open ? (
        <div className="motion-disclosure-enter mt-2 space-y-2 border-t border-border/30 pt-2">
          {isError && block.failureReason ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
                Failure
              </div>
              <div className="whitespace-pre-wrap break-words text-xs text-red-700 dark:text-red-300">
                {block.failureReason}
              </div>
            </div>
          ) : null}
          <div>
            <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
              Paths
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
              {paths.join("\n")}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
              Raw event
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
              {block.rawText}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function TranscriptEventRow({
  block,
  density,
  presentation = "default",
}: {
  block: Extract<TranscriptBlock, { type: "event" }>;
  density: TranscriptDensity;
  presentation?: TranscriptPresentation;
}) {
  const [open, setOpen] = useState(!block.collapseByDefault);
  const compact = density === "compact";
  const detail = presentation === "detail";
  const collapsible = block.collapseByDefault === true;
  const isFileChange = block.label === "file change";
  const preview = truncate(compactWhitespace(block.text), compact ? 96 : 140);
  const toneClasses =
    block.tone === "error"
      ? "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-red-700 dark:text-red-300"
      : block.tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : block.tone === "info"
          ? "text-sky-700 dark:text-sky-300"
          : "text-foreground/75";

  if (isFileChange) {
    const isWarn = block.tone === "warn" || block.tone === "error";
    return (
      <div
        data-transcript-file-change="true"
        className={cn("max-w-full", detail ? "py-0.5" : undefined)}
        title={getTranscriptTimestampTitle(block.ts)}
      >
        <button
          type="button"
          className={cn(
            "inline-flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
            compact ? "text-xs leading-5" : "text-sm leading-6",
            isWarn
              ? "border-amber-500/25 bg-amber-500/[0.06] text-amber-800 hover:bg-amber-500/[0.10] dark:text-amber-200"
              : "border-border/45 bg-muted/10 text-foreground/72 hover:bg-muted/20",
          )}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <FileDiff className={cn("h-3.5 w-3.5 shrink-0", isWarn ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground")} />
          <span className="shrink-0 font-medium text-muted-foreground">
            File Change
          </span>
          <span className="min-w-0 truncate">
            {preview || "Updated files"}
          </span>
          {block.detail ? (
            <DisclosureChevron open={open} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : null}
        </button>
        {block.detail && open ? (
          <pre className={cn(
            "motion-disclosure-enter mt-1.5 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border/35 bg-muted/10 p-2 font-mono text-[11px] text-foreground/75",
            detail ? "ml-0" : "ml-5",
          )}>
            {block.detail}
          </pre>
        ) : null}
      </div>
    );
  }

  return (
    <div className={toneClasses} title={getTranscriptTimestampTitle(block.ts)}>
      <div className="flex items-start gap-2">
        {block.tone === "error" ? (
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : block.tone === "warn" ? (
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-current/50" />
        )}
        <div className="min-w-0 flex-1">
          {collapsible && (
            <button
              type="button"
              className={cn(
                "mb-1 inline-flex max-w-full items-center gap-1 rounded-md text-left font-medium transition-colors hover:text-red-800 dark:hover:text-red-100",
                compact ? "text-[11px]" : "text-xs",
              )}
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-label={open ? "Collapse stderr details" : "Expand stderr details"}
            >
              <DisclosureChevron open={open} className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {formatTranscriptLabel(block.label)}: {preview || "Details"}
              </span>
            </button>
          )}
          {block.label === "result" && block.tone !== "error" ? (
            <div className={cn("whitespace-pre-wrap break-words text-sky-700 dark:text-sky-300", compact ? "text-[11px]" : "text-xs")}>
              {block.text}
            </div>
          ) : collapsible && !open ? null : detail ? (
            <div className={cn(collapsible && open && "motion-disclosure-enter", "whitespace-pre-wrap break-words", compact ? "text-[11px]" : "text-xs")}>
              {block.text}
            </div>
          ) : (
            <div className={cn(collapsible && open && "motion-disclosure-enter", "whitespace-pre-wrap break-words", compact ? "text-[11px]" : "text-xs")}>
              <span className="text-[10px] font-semibold tracking-[0.05em] text-muted-foreground/70">
                {formatTranscriptLabel(block.label)}
              </span>
              {block.text ? <span className="ml-2">{block.text}</span> : null}
            </div>
          )}
          {block.detail && (!collapsible || open) && (
            <pre className={cn(block.collapseByDefault && open && "motion-disclosure-enter", "mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/75")}>
              {block.detail}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function TranscriptStdoutRow({
  block,
  density,
  collapseByDefault,
  presentation = "default",
}: {
  block: Extract<TranscriptBlock, { type: "stdout" }>;
  density: TranscriptDensity;
  collapseByDefault: boolean;
  presentation?: TranscriptPresentation;
}) {
  const [open, setOpen] = useState(!collapseByDefault);
  const detail = presentation === "detail";

  return (
    <div title={getTranscriptTimestampTitle(block.ts)}>
      {detail ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse stdout details" : "Expand stdout details"}
          >
            <DisclosureChevron open={open} className="h-4 w-4" />
          </button>
          <span className="text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
            details
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
            Stdout
          </span>
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse stdout" : "Expand stdout"}
          >
            <DisclosureChevron open={open} className="h-4 w-4" />
          </button>
        </div>
      )}
      {open && (
        <pre className={cn(
          "motion-disclosure-enter",
          detail ? "overflow-x-auto whitespace-pre-wrap break-words font-mono text-foreground/80" : "mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-foreground/80",
          density === "compact" ? "text-[11px]" : "text-xs",
        )}>
          {block.text}
        </pre>
      )}
    </div>
  );
}

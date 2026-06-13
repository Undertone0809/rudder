import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { TranscriptEntry } from "../../agent-runtimes";
import { MarkdownBody, type MarkdownLinkClickHandler } from "../MarkdownBody";
import { cn, formatTokens } from "../../lib/utils";
import { readDesktopShell } from "../../lib/desktop-shell";
import { stripBenignStderr } from "../../lib/benign-stderr";
import { useOptionalToast } from "../../context/ToastContext";
import {
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
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
import { TranscriptMode, TranscriptDensity, TranscriptPresentation, TranscriptToolCategory, TranscriptDigestBucket, TranscriptActionIconCategory, TranscriptActionIconStatus, TranscriptActionIconTreatment, TranscriptToolSemanticInfo, TranscriptToolCardEntry, TranscriptMemoryScope, TranscriptMemoryUpdateChange, TranscriptTodoListItem, RunTranscriptViewProps, TranscriptBlock, ChatTranscriptTurn, ChatTranscriptAction, COMMON_FILENAME_TOKENS, STRONG_WRITE_COMMAND_TOKENS, LONG_EVENT_COLLAPSE_CHARS, LONG_EVENT_COLLAPSE_LINES, LOCAL_POSIX_FILE_ROOTS, TranscriptMarkdownLinkClickHandler, asRecord, decodeFileUrlPath, resolveTranscriptLocalFileTarget, shouldHandlePlainClick, compactWhitespace, isTurnStartedText, isRudderDeveloperDiagnosticLine, isRudderDeveloperDiagnosticContinuationLine, filterRoutineStdout, isWarningStderrLine, isAnalyticsForbiddenHtmlStart, filterRenderableTranscriptEntries, shouldCollapseEventText, formatTranscriptTimestamp, getTranscriptActionIconTreatment, getTranscriptActionIconTone, TranscriptActionIcon, TranscriptActionIconSlot, TranscriptActionIconStack, getTranscriptTimestampTitle, formatTranscriptDuration, truncate, pluralize, humanizeLabel } from "./RunTranscriptView.common";
import { decodeShellEscapes, stripWrappedShell, tokenizeShellForClassification, shellTokensForCommand, isShellControlToken, commandSegmentFrom, splitShellCommandSegments, hasHelpSignal, hasStdoutWriteRedirect, extractStdoutWriteRedirectTarget, extractStdoutWriteRedirectTargetFromTokens, commandSegmentHasStdoutWriteRedirect, commandUsesInPlaceSed, commandUsesInPlacePerl, isPackageInstallCommand, commandSegmentUsesInPlaceSed, commandSegmentUsesInPlacePerl, findStrongEditSegment, hasPackageInstallSegment, getShellPositionalArgsFromTokens, classifyShellCommand, unwrapQuotedToken, cleanShellToken, normalizeTranscriptPathToken, titleCaseAgentSlug, inferAgentNameFromMemoryPath, classifyAgentMemoryPath, formatMemoryScopeLabel, formatMemoryScopeSummary, formatMemoryEffect, formatMemoryOperation, splitFileChangeEntries, extractMemoryUpdateFailureReason, parseMemoryUpdateSystemText, tokenizeShell } from "./RunTranscriptView.shell";
import { normalizePathTarget, dedupeTargets, extractSkillSlugFromEntryPath, extractSkillSlugsFromEntryPaths, formatSkillUseAction, isLikelyPathToken, isLikelySedExpressionToken, getShellPositionalArgs, extractRecordPaths, extractRecordQuery, readStringField, extractQueryValues, extractWebSearchQueries, isWebSearchTool, formatWebSearchSummary, McpToolDetails, MCP_METADATA_KEYS, parseMcpToolName, sanitizeMcpArgs, extractMcpToolDetails, summarizeMcpValue, summarizeMcpArgs, formatMcpLabel, formatMcpSummary, formatTargetAction, quoteSummaryText, formatSearchActionSummary, summarizeCommandPhrase, extractShellFlagValue, formatRudderTarget, summarizeIssueComment, describeRudderCommandSemanticInfo, describeCommandSemanticInfo, formatUnknown, formatToolPayload, extractToolUseId, describeToolInvocation, summarizeRecord, summarizeToolInput, parseStructuredToolResult, formatCommandTerminalOutput, isCommandTool, describeToolSemanticInfo } from "./RunTranscriptView.semantic";
import { formatSemanticDigest, summarizeToolResult, parseSystemActivity, getTodoListCompletedCount, formatTodoListSummary, formatTodoListRaw, shouldHideNiceModeStderr, groupCommandBlocks, segmentTranscriptEntriesByTurn, normalizeTranscript, summarizeChatTurn, normalizeChatTranscriptTurns } from "./RunTranscriptView.normalize";
import { TranscriptMessageBlock, TranscriptThinkingBlock, renderTranscriptBlock, CommandTerminalDetail, TranscriptToolCard, hasSelectedText, DisclosureChevron, areAllToolEntriesErrored, formatTranscriptLabel, TranscriptCommandGroup, TranscriptActivityRow, TranscriptTodoListRow, TranscriptMemoryUpdateRow, TranscriptEventRow, TranscriptStdoutRow } from "./RunTranscriptView.blocks";

export function flattenChatTranscriptActions(blocks: TranscriptBlock[]): ChatTranscriptAction[] {
  const actions: ChatTranscriptAction[] = [];

  for (const block of blocks) {
    if (block.type === "command_group") {
      block.items.forEach((entry, index) => {
        actions.push({
          key: `tool-${entry.ts}-${index}`,
          type: "tool",
          entry,
        });
      });
      continue;
    }

    if (block.type === "tool") {
      actions.push({
        key: `tool-${block.ts}-${block.toolUseId ?? block.name}`,
        type: "tool",
        entry: {
          ts: block.ts,
          endTs: block.endTs,
          name: block.name,
          input: block.input,
          result: block.result,
          isError: block.isError,
          status: block.status,
        },
      });
      continue;
    }

    if (block.type === "stdout") {
      actions.push({
        key: `stdout-${block.ts}`,
        type: "stdout",
        entry: block,
      });
    }
  }

  return actions;
}

export function getToolCommand(block: TranscriptToolCardEntry): string | null {
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

export function shouldHideChatToolResult(semantic: TranscriptToolSemanticInfo): boolean {
  return semantic.category === "read" || semantic.category === "skill";
}

function TranscriptChatActionIconCell({
  category,
  status,
  compact,
}: {
  category: TranscriptActionIconCategory;
  status: TranscriptActionIconStatus;
  compact: boolean;
}) {
  if (!compact) {
    return <TranscriptActionIconSlot category={category} status={status} />;
  }

  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
      data-transcript-action-icon-slot="true"
    >
      <TranscriptActionIcon category={category} status={status} />
    </span>
  );
}

export function TranscriptChatStdoutActionRow({
  block,
  density,
  inline = false,
}: {
  block: Extract<TranscriptBlock, { type: "stdout" }>;
  density: TranscriptDensity;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(inline);
  const preview = truncate(compactWhitespace(block.text), density === "compact" ? 80 : 120) || "Output";
  const compact = density === "compact";
  const rowPaddingClass = compact ? "py-0.5" : "py-1.5";
  const rowAlignmentClass = compact ? "items-center" : "items-start";
  const rowGapClass = compact ? "gap-1.5" : "gap-2";
  const chevronOffsetClass = compact ? "" : "mt-0.5";

  if (inline) {
    return (
      <div className={rowPaddingClass} title={getTranscriptTimestampTitle(block.ts)}>
        <div className={cn("flex w-full text-left", rowAlignmentClass, rowGapClass)}>
          <TranscriptChatActionIconCell category="stdout" status="completed" compact={compact} />
          <pre className={cn(
            "min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-foreground/80",
            compact ? "text-[11px] leading-5" : "text-xs leading-6",
          )}>
            {block.text}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className={rowPaddingClass} title={getTranscriptTimestampTitle(block.ts)}>
      <button
        type="button"
        className={cn("flex w-full text-left", rowAlignmentClass, rowGapClass)}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse output details" : "Expand output details"}
      >
        <TranscriptChatActionIconCell category="stdout" status="completed" compact={compact} />
        <span className={cn("min-w-0 flex-1 break-words text-foreground/82", compact ? "text-xs leading-5" : "text-sm leading-6")}>
          {preview}
        </span>
        <span className={cn("inline-flex h-5 w-5 items-center justify-center text-muted-foreground", chevronOffsetClass)}>
          <DisclosureChevron open={open} className="h-4 w-4" />
        </span>
      </button>
      {open ? (
        <pre className={cn(
          "motion-disclosure-enter",
          "mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border/35 bg-muted/10 p-2.5 font-mono text-foreground/80",
          density === "compact" ? "text-[11px]" : "text-xs",
        )}>
          {block.text}
        </pre>
      ) : null}
    </div>
  );
}

export function TranscriptChatToolActionRow({
  block,
  density,
  inline = false,
  defaultOpenOnError = true,
  highlightError = true,
}: {
  block: TranscriptToolCardEntry;
  density: TranscriptDensity;
  inline?: boolean;
  defaultOpenOnError?: boolean;
  highlightError?: boolean;
}) {
  const semantic = describeToolSemanticInfo(block.name, block.input);
  const compact = density === "compact";
  const isCommand = isCommandTool(block.name, block.input);
  const command = getToolCommand(block);
  const requestText = command ?? (formatToolPayload(block.input) || "<empty>");
  const responseText = shouldHideChatToolResult(semantic)
    ? null
    : command
      ? formatCommandTerminalOutput(block.result)
      : block.result
        ? formatToolPayload(block.result)
        : block.status === "running"
          ? "Waiting for result..."
          : null;
  const canExpand = Boolean(command || responseText || (!isCommand && requestText !== "<empty>"));
  const [open, setOpen] = useState(inline || (defaultOpenOnError && block.status === "error"));
  const duration = formatTranscriptDuration(block.ts, block.endTs);
  const statusText =
    block.status === "error"
      ? "Failed"
      : block.status === "running"
        ? "Running"
        : null;
  const rowTone = block.status === "error"
    ? "text-red-700 dark:text-red-300"
    : block.status === "running"
      ? "text-cyan-700 dark:text-cyan-300"
      : "text-muted-foreground";
  const iconStatus = block.status === "error" ? "error" : block.status === "running" ? "running" : "completed";
  const rowPaddingClass = compact ? "py-0.5" : "py-1.5";
  const rowAlignmentClass = compact ? "items-center" : "items-start";
  const rowGapClass = compact ? "gap-1.5" : "gap-2";
  const trailingOffsetClass = compact ? "" : "pt-0.5";
  const chevronOffsetClass = compact ? "" : "mt-0.5";

  return (
    <div
      className={cn(rowPaddingClass, highlightError && block.status === "error" && "-mx-2 rounded-lg bg-red-500/[0.04] px-2")}
      title={getTranscriptTimestampTitle(block.ts)}
    >
      <button
        type="button"
        className={cn("flex w-full text-left", rowAlignmentClass, rowGapClass)}
        onClick={() => {
          if (inline) return;
          if (!canExpand) return;
          setOpen((value) => !value);
        }}
        aria-expanded={canExpand && !inline ? open : undefined}
        aria-label={
          canExpand && !inline
            ? open
              ? `Collapse ${isCommand ? "command" : "tool"} details`
              : `Expand ${isCommand ? "command" : "tool"} details`
            : undefined
        }
      >
        <TranscriptChatActionIconCell category={semantic.category} status={iconStatus} compact={compact} />
        <span className={cn("min-w-0 flex-1 break-words text-foreground/84", compact ? "text-xs leading-5" : "text-sm leading-6")}>
          {semantic.summary}
        </span>
        {duration ? (
          <span className={cn("text-[10px] font-medium tabular-nums text-muted-foreground", trailingOffsetClass)}>
            {duration}
          </span>
        ) : null}
        {statusText ? (
          <span className={cn("text-[10px] font-medium", rowTone, trailingOffsetClass)}>
            {statusText}
          </span>
        ) : null}
        {canExpand && !inline ? (
          <span className={cn("inline-flex h-5 w-5 items-center justify-center text-muted-foreground", chevronOffsetClass)}>
            <DisclosureChevron open={open} className="h-4 w-4" />
          </span>
        ) : null}
      </button>
      {canExpand && open ? (
        command ? (
          <CommandTerminalDetail
            command={requestText}
            output={responseText}
            status={block.status}
            className="motion-disclosure-enter ml-5 mt-2"
          />
        ) : (
          <div className="motion-disclosure-enter ml-5 mt-2 space-y-2 rounded-lg border border-border/35 bg-muted/10 p-2.5">
            <div>
              <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
                Input
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
                {requestText}
              </pre>
            </div>
            {responseText ? (
              <div>
                <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
                  Response
                </div>
                <pre className={cn(
                  "overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]",
                  block.status === "error" ? "text-red-700 dark:text-red-300" : "text-foreground/80",
                )}>
                  {responseText}
                </pre>
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

export function TranscriptChatActionRow({
  action,
  density,
  inline = false,
  defaultOpenOnError = true,
  highlightError = true,
}: {
  action: ChatTranscriptAction;
  density: TranscriptDensity;
  inline?: boolean;
  defaultOpenOnError?: boolean;
  highlightError?: boolean;
}) {
  if (action.type === "stdout") {
    return <TranscriptChatStdoutActionRow block={action.entry} density={density} inline={inline} />;
  }

  return (
    <TranscriptChatToolActionRow
      block={action.entry}
      density={density}
      inline={inline}
      defaultOpenOnError={defaultOpenOnError}
      highlightError={highlightError}
    />
  );
}

export type ChatTranscriptTurnSegment =
  | {
      type: "block";
      key: string;
      block: TranscriptBlock;
    }
  | {
      type: "actions";
      key: string;
      actions: ChatTranscriptAction[];
    };

export function isChatActionBlock(block: TranscriptBlock): boolean {
  return block.type === "tool" || block.type === "command_group" || block.type === "stdout";
}

export function segmentChatTranscriptBlocks(blocks: TranscriptBlock[]): ChatTranscriptTurnSegment[] {
  const segments: ChatTranscriptTurnSegment[] = [];
  let pendingActionBlocks: TranscriptBlock[] = [];

  const flushActions = () => {
    if (pendingActionBlocks.length === 0) return;
    const actions = flattenChatTranscriptActions(pendingActionBlocks);
    if (actions.length > 0) {
      segments.push({
        type: "actions",
        key: `actions-${pendingActionBlocks[0]?.ts ?? segments.length}-${segments.length}`,
        actions,
      });
    }
    pendingActionBlocks = [];
  };

  blocks.forEach((block, index) => {
    if (isChatActionBlock(block)) {
      pendingActionBlocks.push(block);
      return;
    }

    flushActions();
    segments.push({
      type: "block",
      key: `${block.type}-${block.ts}-${index}`,
      block,
    });
  });

  flushActions();
  return segments;
}

export function formatChatActionSummary(actions: ChatTranscriptAction[]): string {
  const infos = actions
    .filter((action): action is Extract<ChatTranscriptAction, { type: "tool" }> => action.type === "tool")
    .map((action) => describeToolSemanticInfo(action.entry.name, action.entry.input));
  const stdoutCount = actions.filter((action) => action.type === "stdout").length;
  return formatSemanticDigest(infos, stdoutCount, { preferDirectSummary: true });
}

export function getChatActionIconInfo(action: ChatTranscriptAction): {
  category: TranscriptActionIconCategory;
  status: TranscriptActionIconStatus;
} {
  if (action.type === "stdout") {
    return { category: "stdout", status: "completed" };
  }
  const semantic = describeToolSemanticInfo(action.entry.name, action.entry.input);
  return {
    category: semantic.category,
    status: action.entry.status === "error" ? "error" : action.entry.status === "running" ? "running" : "completed",
  };
}

export function TranscriptChatActionGroup({
  actions,
  density,
  detailVariant,
  groupIndex,
  groupCount,
}: {
  actions: ChatTranscriptAction[];
  density: TranscriptDensity;
  detailVariant: boolean;
  groupIndex: number;
  groupCount: number;
}) {
  const compact = density === "compact";
  const singleAction = actions[0];
  const hasSingleAction = actions.length === 1;
  const toolEntries = actions
    .filter((action): action is Extract<ChatTranscriptAction, { type: "tool" }> => action.type === "tool")
    .map((action) => action.entry);
  const allToolsErrored = areAllToolEntriesErrored(toolEntries);
  const shouldInlineSingleStdoutAction = hasSingleAction && singleAction?.type === "stdout";
  const shouldRenderSingleToolAction = hasSingleAction && singleAction?.type === "tool";
  const summary = formatChatActionSummary(actions);
  const highlightGroupError = allToolsErrored && !detailVariant;
  const [detailsOpen, setDetailsOpen] = useState(() => (detailVariant ? false : allToolsErrored));
  const visibleGroupIcons = actions.slice(0, 3).map(getChatActionIconInfo);

  useEffect(() => {
    if (!detailVariant && allToolsErrored) {
      setDetailsOpen(true);
    }
  }, [detailVariant, allToolsErrored]);

  if (shouldInlineSingleStdoutAction) {
    return (
      <div className="divide-y divide-border/30">
        <TranscriptChatActionRow
          action={singleAction}
          density={density}
          inline
        />
      </div>
    );
  }

  if (shouldRenderSingleToolAction) {
    return (
      <div className="divide-y divide-border/30">
        <TranscriptChatActionRow
          action={singleAction}
          density={density}
          defaultOpenOnError={!detailVariant}
          highlightError={!detailVariant}
        />
      </div>
    );
  }

  const labelSuffix = groupCount > 1 ? ` group ${groupIndex + 1}` : "";
  const expandedLabel = detailsOpen
    ? `Collapse tool activity${labelSuffix}`
    : `Expand tool activity${labelSuffix}`;

  return (
    <div>
      <button
        type="button"
        className={cn(
          "-mx-2 flex w-[calc(100%+1rem)] items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
          highlightGroupError ? "hover:bg-red-500/[0.05]" : "hover:bg-muted/10",
        )}
        onClick={() => setDetailsOpen((value) => !value)}
        aria-expanded={detailsOpen}
        aria-label={expandedLabel}
      >
        <TranscriptActionIconStack icons={visibleGroupIcons} highlightError={highlightGroupError} />
        <span className="min-w-0 flex-1">
          <span className={cn(
            "block break-words text-foreground/82",
            compact ? "text-xs" : "text-sm",
          )}>
            {summary || "Tool details"}
          </span>
        </span>
        <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground">
          <DisclosureChevron open={detailsOpen} className="h-4 w-4" />
        </span>
      </button>

      {detailsOpen ? (
        <div className="motion-disclosure-enter mt-2 divide-y divide-border/30 border-l border-border/35 pl-3">
          {actions.map((action) => (
            <TranscriptChatActionRow
              key={action.key}
              action={action}
              density={density}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TranscriptChatTurn({
  turn,
  density,
  thinkingClassName,
  variant = "chat",
  onMarkdownLinkClick,
}: {
  turn: ChatTranscriptTurn;
  density: TranscriptDensity;
  thinkingClassName?: string;
  variant?: "chat" | "detail";
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
}) {
  const detailVariant = variant === "detail";
  const segments = segmentChatTranscriptBlocks(turn.blocks);
  const actionGroupCount = segments.filter((segment) => segment.type === "actions").length;
  const content = segments.length > 0 ? (
    <div className={cn(density === "compact" ? "space-y-1" : "space-y-3")} title={getTranscriptTimestampTitle(turn.ts)}>
      {segments.map((segment, index) => (
        segment.type === "block"
          ? renderTranscriptBlock({
              block: segment.block,
              index,
              density,
              presentation: detailVariant ? "detail" : "chat",
              collapseStdout: true,
              thinkingClassName,
              onMarkdownLinkClick,
            })
          : (
            <TranscriptChatActionGroup
              key={segment.key}
              actions={segment.actions}
              density={density}
              detailVariant={detailVariant}
              groupIndex={segments.slice(0, index).filter((item) => item.type === "actions").length}
              groupCount={actionGroupCount}
            />
          )
      ))}
    </div>
  ) : null;
  return content;
}

export function trimTrailingWhitespace(value: string) {
  return value.replace(/\s+$/g, "");
}

export function redactAssistantSuffixFromChatTranscript(
  entries: TranscriptEntry[],
  hiddenAssistantMessageText: string | null | undefined,
) {
  let remaining = trimTrailingWhitespace(hiddenAssistantMessageText ?? "");
  if (!remaining) return entries;

  const nextEntries: TranscriptEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "assistant" || !remaining) {
      nextEntries.push(entry);
      continue;
    }

    const entryText = trimTrailingWhitespace(entry.text);
    remaining = trimTrailingWhitespace(remaining);
    if (!entryText) {
      nextEntries.push(entry);
      continue;
    }

    if (remaining.endsWith(entryText)) {
      remaining = trimTrailingWhitespace(remaining.slice(0, remaining.length - entryText.length));
      continue;
    }

    if (entryText.endsWith(remaining)) {
      const visibleText = trimTrailingWhitespace(entryText.slice(0, entryText.length - remaining.length));
      remaining = "";
      if (visibleText) {
        nextEntries.push({ ...entry, text: visibleText });
      }
      continue;
    }

    nextEntries.push(entry);
  }

  if (remaining) return entries;
  return nextEntries.reverse();
}

export function filterChatAssistantTranscriptEntries(
  entries: TranscriptEntry[],
  options: {
    hideAssistantMessages: boolean;
    hiddenAssistantMessageText?: string | null;
  },
) {
  if (options.hideAssistantMessages) {
    return entries.filter((entry) => entry.kind !== "assistant");
  }
  return redactAssistantSuffixFromChatTranscript(entries, options.hiddenAssistantMessageText);
}

export function TranscriptChatTimeline({
  entries,
  density,
  streaming,
  collapseStdout,
  thinkingClassName,
  hideAssistantMessages,
  hiddenAssistantMessageText,
  showDeveloperDiagnostics,
  onMarkdownLinkClick,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
  streaming: boolean;
  collapseStdout: boolean;
  thinkingClassName?: string;
  hideAssistantMessages: boolean;
  hiddenAssistantMessageText?: string | null;
  showDeveloperDiagnostics: boolean;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
}) {
  const timelineEntries = useMemo(
    () => filterChatAssistantTranscriptEntries(entries, {
      hideAssistantMessages,
      hiddenAssistantMessageText,
    }),
    [entries, hideAssistantMessages, hiddenAssistantMessageText],
  );
  const { preludeBlocks, turns } = useMemo(
    () => normalizeChatTranscriptTurns(timelineEntries, streaming, { showDeveloperDiagnostics }),
    [timelineEntries, streaming, showDeveloperDiagnostics],
  );

  return (
    <div className="space-y-3">
      {preludeBlocks.map((block, index) => renderTranscriptBlock({
        block,
        index,
        density,
        presentation: "chat",
        collapseStdout,
        thinkingClassName,
        onMarkdownLinkClick,
      }))}
      {turns.map((turn) => (
        <TranscriptChatTurn
          key={turn.key}
          turn={turn}
          density={density}
          thinkingClassName={thinkingClassName}
          onMarkdownLinkClick={onMarkdownLinkClick}
        />
      ))}
    </div>
  );
}

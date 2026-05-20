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
import { flattenChatTranscriptActions, getToolCommand, shouldHideChatToolResult, TranscriptChatStdoutActionRow, TranscriptChatToolActionRow, TranscriptChatActionRow, ChatTranscriptTurnSegment, isChatActionBlock, segmentChatTranscriptBlocks, formatChatActionSummary, getChatActionIconInfo, TranscriptChatActionGroup, TranscriptChatTurn, trimTrailingWhitespace, redactAssistantSuffixFromChatTranscript, filterChatAssistantTranscriptEntries, TranscriptChatTimeline } from "./RunTranscriptView.chat";
import { DetailTimelineRow, expandDetailTimelineBlocks, TranscriptDetailTimeline, RawTranscriptView } from "./RunTranscriptView.detail";

export type { TranscriptDensity, TranscriptMode, TranscriptPresentation } from "./RunTranscriptView.common";
export { normalizeTranscript } from "./RunTranscriptView.normalize";
export { resolveTranscriptLocalFileTarget } from "./RunTranscriptView.common";

export function RunTranscriptView({
  entries,
  mode = "nice",
  density = "comfortable",
  limit,
  streaming = false,
  collapseStdout = false,
  emptyMessage = "No transcript yet.",
  className,
  thinkingClassName,
  presentation = "default",
  showDeveloperDiagnostics = false,
  hideAssistantMessages = false,
  hiddenAssistantMessageText = null,
}: RunTranscriptViewProps) {
  const toastContext = useOptionalToast();
  const handleMarkdownLinkClick = useCallback<TranscriptMarkdownLinkClickHandler>(({ event, href }) => {
    if (!shouldHandlePlainClick(event)) return;

    const targetPath = resolveTranscriptLocalFileTarget(href);
    if (!targetPath) return;

    event.preventDefault();
    event.stopPropagation();

    const desktopShell = readDesktopShell();
    if (!desktopShell) {
      toastContext?.pushToast({
        title: "Open from Desktop",
        body: "Local transcript file links can only be opened from the Rudder Desktop app.",
        tone: "warn",
      });
      return true;
    }

    void desktopShell.openPath(targetPath).catch((error) => {
      toastContext?.pushToast({
        title: "Failed to open file",
        body: error instanceof Error ? error.message : `Could not open ${targetPath}.`,
        tone: "error",
      });
    });
    return true;
  }, [toastContext]);
  const renderableEntries = useMemo(
    () => filterRenderableTranscriptEntries(entries, { showDeveloperDiagnostics }),
    [entries, showDeveloperDiagnostics],
  );
  const blocks = useMemo(
    () => normalizeTranscript(renderableEntries, streaming, { showDeveloperDiagnostics }),
    [renderableEntries, streaming, showDeveloperDiagnostics],
  );
  const visibleBlocks = limit ? blocks.slice(-limit) : blocks;
  const visibleEntries = limit ? renderableEntries.slice(-limit) : renderableEntries;

  if (renderableEntries.length === 0) {
    return (
      <div className={cn("rounded-2xl border border-dashed border-border/70 bg-background/40 p-4 text-sm text-muted-foreground", className)}>
        {emptyMessage}
      </div>
    );
  }

  if (mode === "raw") {
    return (
      <div className={className}>
        <RawTranscriptView entries={visibleEntries} density={density} />
      </div>
    );
  }

  if (presentation === "detail") {
    return (
      <div className={cn("space-y-4", className)}>
        <TranscriptDetailTimeline
          entries={visibleEntries}
          density={density}
          streaming={streaming}
          thinkingClassName={thinkingClassName}
          showDeveloperDiagnostics={showDeveloperDiagnostics}
          onMarkdownLinkClick={handleMarkdownLinkClick}
        />
      </div>
    );
  }

  if (presentation === "chat") {
    return (
      <div className={className}>
        <TranscriptChatTimeline
          entries={visibleEntries}
          density={density}
          streaming={streaming}
          collapseStdout={collapseStdout}
          thinkingClassName={thinkingClassName}
          hideAssistantMessages={hideAssistantMessages}
          hiddenAssistantMessageText={hiddenAssistantMessageText}
          showDeveloperDiagnostics={showDeveloperDiagnostics}
          onMarkdownLinkClick={handleMarkdownLinkClick}
        />
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {visibleBlocks.map((block, index) => (
        <div
          key={`${block.type}-${block.ts}-${index}`}
          className={cn(index === visibleBlocks.length - 1 && streaming && "animate-in fade-in slide-in-from-bottom-1 duration-300")}
        >
          {renderTranscriptBlock({
            block,
            index,
            density,
            presentation,
            collapseStdout,
            thinkingClassName,
            onMarkdownLinkClick: handleMarkdownLinkClick,
          })}
        </div>
      ))}
    </div>
  );
}

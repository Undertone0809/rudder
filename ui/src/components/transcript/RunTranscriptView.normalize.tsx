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

export function formatSemanticDigest(
  infos: TranscriptToolSemanticInfo[],
  fallbackLogCount = 0,
  options?: { preferDirectSummary?: boolean },
): string {
  const meaningfulInfos = infos.filter((info) => Boolean(info.summary));
  if (options?.preferDirectSummary && meaningfulInfos.length === 1) {
    return meaningfulInfos[0]?.summary ?? "";
  }

  let exploreCount = 0;
  let searchCount = 0;
  let editCount = 0;
  let runCount = 0;
  let toolCount = 0;
  const exploreNouns = new Set<TranscriptToolSemanticInfo["noun"]>();
  const editNouns = new Set<TranscriptToolSemanticInfo["noun"]>();

  for (const info of meaningfulInfos) {
    if (info.bucket === "explore") {
      exploreCount += info.quantity;
      exploreNouns.add(info.noun);
      continue;
    }
    if (info.bucket === "search") {
      searchCount += info.quantity;
      continue;
    }
    if (info.bucket === "edit") {
      editCount += info.quantity;
      editNouns.add(info.noun);
      continue;
    }
    if (info.bucket === "run") {
      runCount += info.quantity;
      continue;
    }
    if (info.bucket === "tool") {
      toolCount += info.quantity;
    }
  }

  const parts: string[] = [];
  if (exploreCount > 0) {
    const noun = exploreNouns.size === 1 ? [...exploreNouns][0] : "item";
    parts.push(
      noun === "skill"
        ? `Used ${exploreCount} ${pluralize(noun, exploreCount)}`
        : `Explored ${exploreCount} ${pluralize(noun, exploreCount)}`,
    );
  }
  if (searchCount > 0) {
    parts.push(`${searchCount} ${pluralize("search", searchCount)}`);
  }
  if (editCount > 0) {
    const noun = editNouns.size === 1 ? [...editNouns][0] : "item";
    parts.push(`Edited ${editCount} ${pluralize(noun, editCount)}`);
  }
  if (runCount > 0) {
    parts.push(`Ran ${runCount} ${pluralize("command", runCount)}`);
  }
  if (toolCount > 0) {
    parts.push(`Used ${toolCount} ${pluralize("tool", toolCount)}`);
  }
  if (parts.length === 0 && fallbackLogCount > 0) {
    parts.push(`${fallbackLogCount} ${pluralize("log", fallbackLogCount)}`);
  }

  return parts
    .map((part, index) => (index === 0 ? part : `${part.charAt(0).toLowerCase()}${part.slice(1)}`))
    .join(", ");
}

export function summarizeToolResult(result: string | undefined, isError: boolean | undefined, density: TranscriptDensity): string {
  if (!result) return isError ? "Tool failed" : "Waiting for result";
  const structured = parseStructuredToolResult(result);
  if (structured) {
    if (structured.body) {
      return truncate(structured.body.split("\n")[0] ?? structured.body, density === "compact" ? 84 : 140);
    }
    if (structured.status === "completed") return "Completed";
    if (structured.status === "failed" || structured.status === "error") {
      return structured.exitCode ? `Failed with exit code ${structured.exitCode}` : "Failed";
    }
  }
  const lines = result
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
  const firstLine = lines[0] ?? result;
  return truncate(firstLine, density === "compact" ? 84 : 140);
}

export function parseSystemActivity(text: string): { activityId?: string; name: string; status: "running" | "completed" } | null {
  const match = text.match(/^item (started|completed):\s*([a-z0-9_-]+)(?:\s+\(id=([^)]+)\))?$/i);
  if (!match) return null;
  return {
    status: match[1].toLowerCase() === "started" ? "running" : "completed",
    name: humanizeLabel(match[2] ?? "Activity"),
    activityId: match[3] || undefined,
  };
}

export function getTodoListCompletedCount(items: TranscriptTodoListItem[]): number {
  return items.filter((item) => item.status === "completed").length;
}

export function formatTodoListSummary(items: TranscriptTodoListItem[]): string {
  const completed = getTodoListCompletedCount(items);
  return `Todo list updated: ${completed}/${items.length} complete`;
}

export function formatTodoListRaw(items: TranscriptTodoListItem[]): string {
  return items
    .map((item) => `${item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]"} ${item.text}`)
    .join("\n");
}

interface ClaudeSkillContext {
  slug: string | null;
  baseDirectory: string;
  args: string | null;
  rawText: string;
}

export function parseClaudeSkillContext(text: string): ClaudeSkillContext | null {
  const baseMatch = text.match(/^Base directory for this skill:\s*(.+)$/m);
  if (!baseMatch) return null;

  const baseDirectory = compactWhitespace(baseMatch[1] ?? "");
  if (!baseDirectory) return null;

  const pathSlug = extractSkillSlugFromEntryPath(`${baseDirectory.replace(/\/+$/, "")}/SKILL.md`);
  const headingMatch = text.match(/^#\s+(.+?)\s+Skill\s*$/m);
  const headingSlug = headingMatch?.[1]
    ? headingMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : null;
  const argsMatch = text.match(/^ARGUMENTS:\s*(.*)$/m);

  return {
    slug: pathSlug ?? headingSlug,
    baseDirectory,
    args: argsMatch?.[1] ? compactWhitespace(argsMatch[1]) : null,
    rawText: text,
  };
}

function isSkillToolBlock(block: TranscriptBlock | undefined): block is Extract<TranscriptBlock, { type: "tool" }> {
  return block?.type === "tool" && block.name.trim().toLowerCase() === "skill";
}

function readSkillToolName(input: unknown): string | null {
  const record = asRecord(input);
  return readStringField(record, ["skill", "name"]);
}

function normalizeSkillSlug(value: string | null): string | null {
  return value ? value.trim().toLowerCase() : null;
}

function appendClaudeSkillContextToTool(
  block: Extract<TranscriptBlock, { type: "tool" }>,
  context: ClaudeSkillContext,
  ts: string,
) {
  const skillName = readSkillToolName(block.input) ?? context.slug ?? "skill";
  const contextSummary = [
    `Loaded skill context: ${skillName}`,
    `Base directory: ${context.baseDirectory}`,
    context.args ? `Arguments: ${context.args}` : null,
  ].filter(Boolean).join("\n");
  const existingResult = block.result?.trim();
  block.result = [
    existingResult || `Launching skill: ${skillName}`,
    contextSummary,
    "",
    context.rawText,
  ].join("\n");
  block.status = "completed";
  block.isError = false;
  block.endTs = ts;
}

export function shouldHideNiceModeStderr(text: string): boolean {
  const normalized = compactWhitespace(text).toLowerCase();
  return normalized.startsWith("[rudder] skipping saved session resume");
}

export function getSystemEventTone(text: string): Extract<TranscriptBlock, { type: "event" }>["tone"] {
  const normalized = compactWhitespace(text).toLowerCase();
  if (/^file(?: changes|_change):\s*/.test(normalized)) return "neutral";
  return "warn";
}

export function groupCommandBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const grouped: TranscriptBlock[] = [];
  let pending: Array<Extract<TranscriptBlock, { type: "command_group" }>["items"][number]> = [];
  let groupTs: string | null = null;
  let groupEndTs: string | undefined;

  const flush = () => {
    if (pending.length === 0 || !groupTs) return;
    grouped.push({
      type: "command_group",
      ts: groupTs,
      endTs: groupEndTs,
      items: pending,
    });
    pending = [];
    groupTs = null;
    groupEndTs = undefined;
  };

  for (const block of blocks) {
    if (block.type === "tool" && isCommandTool(block.name, block.input)) {
      if (!groupTs) {
        groupTs = block.ts;
      }
      groupEndTs = block.endTs ?? block.ts;
      pending.push({
        ts: block.ts,
        endTs: block.endTs,
        name: block.name,
        input: block.input,
        result: block.result,
        isError: block.isError,
        status: block.status,
      });
      continue;
    }

    flush();
    grouped.push(block);
  }

  flush();
  return grouped;
}

export function segmentTranscriptEntriesByTurn(entries: TranscriptEntry[]): {
  preludeEntries: TranscriptEntry[];
  turnEntries: TranscriptEntry[][];
} {
  const preludeEntries: TranscriptEntry[] = [];
  const turnEntries: TranscriptEntry[][] = [];
  let currentTurn: TranscriptEntry[] | null = null;

  const flushTurn = () => {
    if (!currentTurn || currentTurn.length === 0) {
      currentTurn = null;
      return;
    }
    turnEntries.push(currentTurn);
    currentTurn = null;
  };

  for (const entry of entries) {
    if (entry.kind === "system" && isTurnStartedText(entry.text)) {
      flushTurn();
      currentTurn = [];
      continue;
    }

    if (!currentTurn) {
      if (entry.kind === "init") {
        preludeEntries.push(entry);
        continue;
      }
      currentTurn = [];
    }

    currentTurn.push(entry);
  }

  flushTurn();
  return { preludeEntries, turnEntries };
}

export function normalizeTranscript(
  entries: TranscriptEntry[],
  streaming: boolean,
  options?: { showDeveloperDiagnostics?: boolean },
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const pendingToolBlocks = new Map<string, Extract<TranscriptBlock, { type: "tool" }>>();
  const pendingActivityBlocks = new Map<string, Extract<TranscriptBlock, { type: "activity" }>>();
  const pendingTodoListBlocks = new Map<string, Extract<TranscriptBlock, { type: "todo_list" }>>();

  for (const entry of entries) {
    const previous = blocks[blocks.length - 1];

    if (entry.kind === "assistant" || entry.kind === "user") {
      if (entry.kind === "user") {
        const skillContext = parseClaudeSkillContext(entry.text);
        if (skillContext) {
          const matchingTool = [...blocks].reverse().find((block): block is Extract<TranscriptBlock, { type: "tool" }> => {
            if (!isSkillToolBlock(block)) return false;
            const toolSkill = normalizeSkillSlug(readSkillToolName(block.input));
            const contextSkill = normalizeSkillSlug(skillContext.slug);
            return !contextSkill || !toolSkill || toolSkill === contextSkill;
          });
          if (matchingTool) {
            appendClaudeSkillContextToTool(matchingTool, skillContext, entry.ts);
            continue;
          }
          blocks.push({
            type: "event",
            ts: entry.ts,
            label: "skill context",
            tone: "info",
            text: `Loaded ${skillContext.slug ?? "skill"} context`,
            detail: skillContext.rawText,
            collapseByDefault: true,
          });
          continue;
        }
      }

      const isStreaming = streaming && entry.kind === "assistant" && entry.delta === true;
      if (previous?.type === "message" && previous.role === entry.kind) {
        previous.text += previous.text.endsWith("\n") || entry.text.startsWith("\n") ? entry.text : `\n${entry.text}`;
        previous.ts = entry.ts;
        previous.streaming = previous.streaming || isStreaming;
      } else {
        blocks.push({
          type: "message",
          role: entry.kind,
          ts: entry.ts,
          text: entry.text,
          streaming: isStreaming,
        });
      }
      continue;
    }

    if (entry.kind === "thinking") {
      const isStreaming = streaming && entry.delta === true;
      if (previous?.type === "thinking") {
        previous.text += previous.text.endsWith("\n") || entry.text.startsWith("\n") ? entry.text : `\n${entry.text}`;
        previous.ts = entry.ts;
        previous.streaming = previous.streaming || isStreaming;
      } else {
        blocks.push({
          type: "thinking",
          ts: entry.ts,
          text: entry.text,
          streaming: isStreaming,
        });
      }
      continue;
    }

    if (entry.kind === "tool_call") {
      const toolBlock: Extract<TranscriptBlock, { type: "tool" }> = {
        type: "tool",
        ts: entry.ts,
        name: entry.name,
        toolUseId: entry.toolUseId ?? extractToolUseId(entry.input),
        input: entry.input,
        status: "running",
      };
      blocks.push(toolBlock);
      if (toolBlock.toolUseId) {
        pendingToolBlocks.set(toolBlock.toolUseId, toolBlock);
      }
      continue;
    }

    if (entry.kind === "tool_result") {
      const matched =
        pendingToolBlocks.get(entry.toolUseId)
        ?? [...blocks].reverse().find((block): block is Extract<TranscriptBlock, { type: "tool" }> => block.type === "tool" && block.status === "running");

      if (matched) {
        matched.result = entry.content;
        matched.isError = entry.isError;
        matched.status = entry.isError ? "error" : "completed";
        matched.endTs = entry.ts;
        pendingToolBlocks.delete(entry.toolUseId);
      } else {
        blocks.push({
          type: "tool",
          ts: entry.ts,
          endTs: entry.ts,
          name: entry.toolName ?? "tool",
          toolUseId: entry.toolUseId,
          input: null,
          result: entry.content,
          isError: entry.isError,
          status: entry.isError ? "error" : "completed",
        });
      }
      continue;
    }

    if (entry.kind === "todo_list") {
      if (entry.items.length === 0) continue;
      const todoListKey = entry.todoListId ?? "default";
      const existing = pendingTodoListBlocks.get(todoListKey);
      if (existing) {
        existing.ts = entry.ts;
        existing.items = entry.items;
      } else {
        const block: Extract<TranscriptBlock, { type: "todo_list" }> = {
          type: "todo_list",
          ts: entry.ts,
          todoListId: entry.todoListId,
          items: entry.items,
        };
        blocks.push(block);
        pendingTodoListBlocks.set(todoListKey, block);
      }
      continue;
    }

    if (entry.kind === "init") {
      blocks.push({
        type: "event",
        ts: entry.ts,
        label: "init",
        tone: "info",
        text: `model ${entry.model}${entry.sessionId ? ` • session ${entry.sessionId}` : ""}`,
      });
      continue;
    }

    if (entry.kind === "result") {
      blocks.push({
        type: "event",
        ts: entry.ts,
        label: "result",
        tone: entry.isError ? "error" : "info",
        text: entry.text.trim() || entry.errors[0] || (entry.isError ? "Run failed" : "Completed"),
      });
      continue;
    }

    if (entry.kind === "stderr") {
      if (shouldHideNiceModeStderr(entry.text)) {
        continue;
      }
      blocks.push({
        type: "event",
        ts: entry.ts,
        label: "stderr",
        tone: "error",
        text: entry.text,
        collapseByDefault: shouldCollapseEventText(entry.text),
      });
      continue;
    }

    if (entry.kind === "system") {
      if (compactWhitespace(entry.text).toLowerCase() === "turn started") {
        continue;
      }
      const memoryUpdate = parseMemoryUpdateSystemText(entry.text, entry.ts);
      if (memoryUpdate) {
        blocks.push(memoryUpdate);
        continue;
      }
      const activity = parseSystemActivity(entry.text);
      if (activity) {
        const existing = activity.activityId ? pendingActivityBlocks.get(activity.activityId) : undefined;
        if (existing) {
          existing.status = activity.status;
          existing.ts = entry.ts;
          if (activity.status === "completed" && activity.activityId) {
            pendingActivityBlocks.delete(activity.activityId);
          }
        } else {
          const block: Extract<TranscriptBlock, { type: "activity" }> = {
            type: "activity",
            ts: entry.ts,
            activityId: activity.activityId,
            name: activity.name,
            status: activity.status,
          };
          blocks.push(block);
          if (activity.status === "running" && activity.activityId) {
            pendingActivityBlocks.set(activity.activityId, block);
          }
        }
        continue;
      }
      blocks.push({
        type: "event",
        ts: entry.ts,
        label: "system",
        tone: getSystemEventTone(entry.text),
        text: entry.text,
      });
      continue;
    }

    const filteredStdout = filterRoutineStdout(entry.text, options?.showDeveloperDiagnostics === true);
    if (!filteredStdout) {
      continue;
    }

    const activeCommandBlock = [...blocks].reverse().find(
      (block): block is Extract<TranscriptBlock, { type: "tool" }> =>
        block.type === "tool" && block.status === "running" && isCommandTool(block.name, block.input),
    );
    if (activeCommandBlock) {
      activeCommandBlock.result = activeCommandBlock.result
        ? `${activeCommandBlock.result}${activeCommandBlock.result.endsWith("\n") || filteredStdout.startsWith("\n") ? filteredStdout : `\n${filteredStdout}`}`
        : filteredStdout;
      continue;
    }

    if (previous?.type === "stdout") {
      previous.text += previous.text.endsWith("\n") || filteredStdout.startsWith("\n") ? filteredStdout : `\n${filteredStdout}`;
      previous.ts = entry.ts;
    } else {
      blocks.push({
        type: "stdout",
        ts: entry.ts,
        text: filteredStdout,
      });
    }
  }

  if (!streaming) {
    for (const block of blocks) {
      if ((block.type === "tool" || block.type === "activity") && block.status === "running") {
        block.status = "completed";
      }
    }
  }

  return groupCommandBlocks(blocks);
}

export function summarizeChatTurn(blocks: TranscriptBlock[]): string | null {
  for (const block of blocks) {
    if (block.type === "message" || block.type === "thinking") {
      const text = compactWhitespace(block.text);
      if (text) return truncate(text, 160);
    }
    if (block.type === "event") {
      const text = compactWhitespace(block.text);
      if (text) return truncate(text, 160);
    }
    if (block.type === "todo_list") {
      return formatTodoListSummary(block.items);
    }
  }

  for (const block of blocks) {
    if (block.type === "command_group") {
      const runningItem = [...block.items].reverse().find((item) => item.status === "running");
      const latestItem = block.items[block.items.length - 1] ?? null;
      const item = runningItem ?? latestItem;
      if (item) {
        const summary = describeToolSemanticInfo(item.name, item.input).summary;
        if (summary) return truncate(summary, 160);
      }
      continue;
    }

    if (block.type === "tool") {
      const summary = describeToolSemanticInfo(block.name, block.input).summary;
      if (summary) return truncate(summary, 160);
      continue;
    }

    if (block.type === "stdout") {
      const text = compactWhitespace(block.text);
      if (text) return truncate(text, 160);
    }
  }

  return null;
}

export function normalizeChatTranscriptTurns(
  entries: TranscriptEntry[],
  streaming: boolean,
  options?: { showDeveloperDiagnostics?: boolean },
): {
  preludeBlocks: TranscriptBlock[];
  turns: ChatTranscriptTurn[];
} {
  const { preludeEntries, turnEntries } = segmentTranscriptEntriesByTurn(entries);
  const preludeBlocks = normalizeTranscript(preludeEntries, streaming, options);
  const turns = turnEntries
    .map((turn, index) => {
      const blocks = normalizeTranscript(turn, streaming, options);
      if (blocks.length === 0) return null;

      const commandCount = blocks.reduce((total, block) => (
        block.type === "command_group" ? total + block.items.length : total
      ), 0);
      const toolCount = blocks.reduce((total, block) => (
        block.type === "tool" ? total + 1 : total
      ), 0);
      const stdoutCount = blocks.reduce((total, block) => (
        block.type === "stdout" ? total + 1 : total
      ), 0);
      const hasRunning = blocks.some((block) => {
        if (block.type === "tool") return block.status === "running";
        if (block.type === "command_group") return block.items.some((item) => item.status === "running");
        if (block.type === "activity") return block.status === "running";
        if (block.type === "todo_list") return block.items.some((item) => item.status === "in_progress");
        if (block.type === "message" || block.type === "thinking") return block.streaming;
        return false;
      });
      const hasError = blocks.some((block) => {
        if (block.type === "tool") return block.status === "error";
        if (block.type === "command_group") return block.items.some((item) => item.status === "error");
        return block.type === "event" && block.tone === "error";
      });

      return {
        key: `turn-${index + 1}-${blocks[0]?.ts ?? index}`,
        index: index + 1,
        ts: blocks[0]?.ts ?? new Date().toISOString(),
        blocks,
        commandCount,
        toolCount,
        stdoutCount,
        hasRunning,
        hasError,
        preview: summarizeChatTurn(blocks),
      } satisfies ChatTranscriptTurn;
    })
    .filter((turn): turn is ChatTranscriptTurn => Boolean(turn));

  return { preludeBlocks, turns };
}

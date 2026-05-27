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

export function normalizePathTarget(value: string): string | null {
  const normalized = cleanShellToken(compactWhitespace(value));
  if (!normalized) return null;
  if (/^(?:&&|\|\||[|;<>])$/.test(normalized)) return null;
  return normalized;
}

export function dedupeTargets(values: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizePathTarget(value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

export function extractSkillSlugFromEntryPath(value: string): string | null {
  const normalized = normalizePathTarget(value)?.replace(/\\/g, "/");
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2 || parts[parts.length - 1] !== "SKILL.md") return null;
  const slug = parts[parts.length - 2];
  if (!slug || slug === "." || slug === "..") return null;
  return slug;
}

export function extractSkillSlugsFromEntryPaths(values: string[]): string[] {
  return dedupeTargets(values.flatMap((value) => {
    const slug = extractSkillSlugFromEntryPath(value);
    return slug ? [slug] : [];
  }));
}

export function formatSkillUseAction(slugs: string[]): Pick<TranscriptToolSemanticInfo, "summary" | "quantity" | "noun"> | null {
  if (slugs.length === 0) return null;
  if (slugs.length === 1) {
    return {
      summary: `Use ${slugs[0]} skill`,
      quantity: 1,
      noun: "skill",
    };
  }
  return {
    summary: `Use ${slugs.length} skills`,
    quantity: slugs.length,
    noun: "skill",
  };
}

export function isLikelyPathToken(token: string): boolean {
  const value = normalizePathTarget(token);
  if (!value || value.startsWith("-")) return false;
  if (/[{}[\]$]/.test(value)) return false;
  if (value.includes("/") || value.startsWith(".") || value.startsWith("~")) return true;
  if (COMMON_FILENAME_TOKENS.has(value)) return true;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/.test(value)) return true;
  return false;
}

export function isLikelySedExpressionToken(token: string): boolean {
  const value = normalizePathTarget(token);
  return Boolean(value && /^(?:s|y|tr)\/.*\/[a-z]*$/i.test(value));
}

export function getShellPositionalArgs(command: string): string[] {
  return getShellPositionalArgsFromTokens(tokenizeShell(command));
}

export function extractRecordPaths(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  const targets: string[] = [];
  for (const key of ["path", "filePath", "file_path", "targetPath", "cwd", "directory", "dir", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      targets.push(value);
    }
  }
  for (const key of ["paths", "files", "filePaths"]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        targets.push(item);
      }
    }
  }
  return dedupeTargets(targets);
}

export function extractRecordQuery(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  for (const key of ["query", "pattern", "search", "q", "text", "prompt", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return compactWhitespace(value);
    }
  }
  return null;
}

export function readStringField(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return compactWhitespace(value);
    }
  }
  return null;
}

export function extractQueryValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [compactWhitespace(value)];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [compactWhitespace(item)];
      const itemRecord = asRecord(item);
      const itemQuery = readStringField(itemRecord, ["query", "q", "keyword", "keywords", "search"]);
      return itemQuery ? [itemQuery] : [];
    });
  }
  const record = asRecord(value);
  const query = readStringField(record, ["query", "q", "keyword", "keywords", "search"]);
  return query ? [query] : [];
}

export function extractWebSearchQueries(input: unknown): string[] {
  const record = asRecord(input);
  if (!record) return [];
  const queries: string[] = [];
  const addQueries = (value: unknown) => {
    for (const query of extractQueryValues(value)) {
      if (!queries.includes(query)) queries.push(query);
    }
  };

  for (const key of ["query", "q", "keyword", "keywords", "queries", "search", "search_query"]) {
    addQueries(record[key]);
  }

  for (const nestedKey of ["action", "web_search", "webSearch", "request", "input"]) {
    const nestedRecord = asRecord(record[nestedKey]);
    if (!nestedRecord) continue;
    for (const key of ["query", "q", "keyword", "keywords", "queries", "search", "search_query"]) {
      addQueries(nestedRecord[key]);
    }
  }

  return queries;
}

export function isWebSearchTool(name: string, input: unknown): boolean {
  const normalized = name.trim().toLowerCase().replace(/[-\s.]+/g, "_");
  if (
    normalized === "web_search" ||
    normalized === "websearch" ||
    normalized === "web_search_call" ||
    normalized === "tool_search_call" ||
    normalized.includes("web_search")
  ) {
    return true;
  }

  const record = asRecord(input);
  return Boolean(record && (record.search_query || record.web_search || record.webSearch));
}

export function formatWebSearchSummary(queries: string[]): string {
  if (queries.length === 1) return `Web searched ${quoteSummaryText(queries[0]!)}`;
  if (queries.length > 1) return `Web searched ${queries.length} queries: ${queries.slice(0, 2).map((query) => quoteSummaryText(query, 32)).join(", ")}`;
  return "Web searched";
}

export interface McpToolDetails {
  server: string | null;
  tool: string | null;
  args: Record<string, unknown> | null;
}

export const MCP_METADATA_KEYS = new Set([
  "id",
  "callId",
  "call_id",
  "toolUseId",
  "tool_use_id",
  "server",
  "serverName",
  "server_name",
  "serverLabel",
  "server_label",
  "tool",
  "toolName",
  "tool_name",
  "name",
  "status",
  "invocation",
  "request",
  "input",
  "args",
  "arguments",
  "params",
]);

export function parseMcpToolName(name: string): Pick<McpToolDetails, "server" | "tool"> | null {
  const parts = name.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") {
    return {
      server: parts[1] || null,
      tool: parts.slice(2).join("__") || null,
    };
  }
  return null;
}

export function sanitizeMcpArgs(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) return null;
  const args = Object.fromEntries(
    Object.entries(record).filter(([key, value]) => !MCP_METADATA_KEYS.has(key) && value !== undefined && value !== null && value !== ""),
  );
  return Object.keys(args).length > 0 ? args : null;
}

export function extractMcpToolDetails(name: string, input: unknown): McpToolDetails | null {
  const nameDetails = parseMcpToolName(name);
  const record = asRecord(input);
  const invocation = asRecord(record?.invocation) ?? asRecord(record?.request) ?? null;
  const server =
    nameDetails?.server ??
    readStringField(invocation, ["server", "serverName", "server_name", "serverLabel", "server_label"]) ??
    readStringField(record, ["server", "serverName", "server_name", "serverLabel", "server_label"]);
  const tool =
    nameDetails?.tool ??
    readStringField(invocation, ["tool", "toolName", "tool_name", "name"]) ??
    readStringField(record, ["tool", "toolName", "tool_name", "name"]);

  const normalized = name.trim().toLowerCase();
  if (!nameDetails && !server && !tool && !normalized.includes("mcp")) return null;

  const explicitArgs =
    asRecord(invocation?.arguments) ??
    asRecord(invocation?.args) ??
    asRecord(invocation?.params) ??
    asRecord(record?.arguments) ??
    asRecord(record?.args) ??
    asRecord(record?.params) ??
    asRecord(record?.input);
  const args = explicitArgs ?? (nameDetails ? sanitizeMcpArgs(record) : null);

  return {
    server: server || null,
    tool: tool || null,
    args,
  };
}

export function summarizeMcpValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return truncate(compactWhitespace(value), 40);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const firstString = value.find((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (firstString) return `${value.length} items, starting with ${truncate(compactWhitespace(firstString), 28)}`;
    if (value.length > 0) return `${value.length} items`;
  }
  return null;
}

export function summarizeMcpArgs(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const priorityKeys = [
    "query",
    "q",
    "url",
    "path",
    "fileKey",
    "nodeId",
    "repo_full_name",
    "repository_full_name",
    "pr_number",
    "issue_number",
    "project",
    "issue",
    "name",
    "title",
    "id",
  ];
  const orderedKeys = [
    ...priorityKeys.filter((key) => Object.prototype.hasOwnProperty.call(args, key)),
    ...Object.keys(args).filter((key) => !priorityKeys.includes(key)),
  ];
  const parts: string[] = [];
  for (const key of orderedKeys) {
    const valueSummary = summarizeMcpValue(args[key]);
    if (!valueSummary) continue;
    parts.push(`${key} ${valueSummary}`);
    if (parts.length >= 2) break;
  }
  return parts.join(", ") || null;
}

export function formatMcpLabel(details: McpToolDetails): string {
  return details.server ? `MCP · ${humanizeLabel(details.server)}` : "MCP";
}

export function formatMcpSummary(details: McpToolDetails): string {
  const tool = details.tool ?? "tool";
  const server = details.server ? ` via ${details.server}` : "";
  const args = summarizeMcpArgs(details.args);
  return `Called ${tool}${server}${args ? ` · ${args}` : ""}`;
}

export function formatTargetAction(
  verb: string,
  targets: string[],
  singular: TranscriptToolSemanticInfo["noun"],
  fallback: string,
): Pick<TranscriptToolSemanticInfo, "summary" | "quantity" | "noun"> {
  if (targets.length === 1) {
    return {
      summary: `${verb} ${targets[0]}`,
      quantity: 1,
      noun: singular,
    };
  }
  if (targets.length > 1) {
    return {
      summary: `${verb} ${targets.length} ${pluralize(singular, targets.length)}`,
      quantity: targets.length,
      noun: singular,
    };
  }
  return {
    summary: fallback,
    quantity: 1,
    noun: singular,
  };
}

export function quoteSummaryText(value: string, max = 48): string {
  return `"${truncate(compactWhitespace(value), max)}"`;
}

export function formatSearchActionSummary(query: string | null, targets: string[], fallback: string): string {
  if (query && targets.length === 1) {
    return `Searched ${quoteSummaryText(query)} in ${targets[0]}`;
  }
  if (query && targets.length > 1) {
    return `Searched ${quoteSummaryText(query)} in ${targets.length} locations`;
  }
  if (query) {
    return `Searched ${quoteSummaryText(query)}`;
  }
  if (targets.length === 1) {
    return `Searched ${targets[0]}`;
  }
  if (targets.length > 1) {
    return `Searched ${targets.length} locations`;
  }
  return fallback;
}

export function summarizeCommandPhrase(command: string): string {
  const tokens = tokenizeShell(command);
  if (tokens.length === 0) return "command";
  const phrase = tokens.slice(0, 3).join(" ");
  return tokens.length > 3 ? `${phrase}…` : phrase;
}

export function extractShellFlagValue(tokens: string[], flag: string): string | null {
  const index = tokens.indexOf(flag);
  if (index === -1) return null;
  const value = tokens[index + 1];
  if (!value) return null;
  if (value === "$") {
    return tokens[index + 2] ?? null;
  }
  return value;
}

export function formatRudderTarget(target: string | undefined): string | null {
  if (!target || target.startsWith("-")) return null;
  const normalized = target.replace(/^#/, "");
  return isShellControlToken(normalized) ? null : normalized;
}

export function summarizeIssueComment(command: string): string | null {
  const tokens = tokenizeShell(command);
  const comment = extractShellFlagValue(tokens, "--comment");
  if (!comment) return null;

  const normalized = comment
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);

  if (!normalized) return "added comment";
  if (/review\s+summary/i.test(normalized)) return "added review summary comment";
  return `added ${quoteSummaryText(normalized, 36)} comment`;
}

export function describeRudderCommandSemanticInfo(command: string): TranscriptToolSemanticInfo | null {
  const tokens = shellTokensForCommand(command);
  const rudderIndex = tokens.findIndex((token) => token === "rudder");
  if (rudderIndex === -1) return null;

  const subcommand = tokens[rudderIndex + 1];
  const action = tokens[rudderIndex + 2];
  if (!subcommand || hasHelpSignal(commandSegmentFrom(tokens, rudderIndex))) {
    return {
      category: "help",
      label: "Rudder help",
      summary: subcommand ? `Checked rudder ${subcommand} help` : "Checked rudder help",
      bucket: "run",
      quantity: 1,
      noun: "command",
    };
  }

  if (subcommand === "issue") {
    if (!action) return null;

    if (action === "comments") {
      const commentsAction = tokens[rudderIndex + 3];
      const commentsTarget = formatRudderTarget(tokens[rudderIndex + 4]);
      return {
        category: "inspect",
        label: "Rudder issue",
        summary: commentsTarget
          ? `Inspected comments for ${commentsTarget}`
          : commentsAction
            ? "Inspected issue comments"
            : "Inspected issues",
        bucket: "run",
        quantity: 1,
        noun: "command",
      };
    }

    const target = formatRudderTarget(tokens[rudderIndex + 3]);

    if (["context", "get", "list"].includes(action)) {
      return {
        category: "inspect",
        label: "Rudder issue",
        summary: target ? `Inspected ${target}` : "Inspected issues",
        bucket: "run",
        quantity: 1,
        noun: "command",
      };
    }

    if (["done", "close", "complete", "comment", "checkout", "update"].includes(action) && target) {
      const commentSummary = summarizeIssueComment(command);
      const suffix = commentSummary ? ` · ${commentSummary}` : "";
      const actionLabel =
        action === "done" || action === "close" || action === "complete"
          ? `Marked ${target} done`
          : action === "comment"
            ? `Commented on ${target}`
            : action === "checkout"
              ? `Checked out ${target}`
              : `Updated ${target}`;

      return {
        category: "script",
        label: "Issue update",
        summary: `${actionLabel}${suffix}`,
        bucket: "run",
        quantity: 1,
        noun: "command",
      };
    }
  }

  if (["agent", "approval", "org", "project", "goal"].includes(subcommand)) {
    return {
      category: "script",
      label: "Rudder command",
      summary: `Ran rudder ${subcommand} command`,
      bucket: "run",
      quantity: 1,
      noun: "command",
    };
  }

  return {
    category: "script",
    label: "Rudder command",
    summary: "Ran rudder command",
    bucket: "run",
    quantity: 1,
    noun: "command",
  };
}

export function describeCommandSemanticInfo(command: string): TranscriptToolSemanticInfo {
  const rudderInfo = describeRudderCommandSemanticInfo(command);
  if (rudderInfo) return rudderInfo;

  const invocation = classifyShellCommand(command);
  const normalized = stripWrappedShell(command);
  const classificationTokens = shellTokensForCommand(command);
  const positionalArgs = getShellPositionalArgs(command);
  const pathTargets = dedupeTargets(positionalArgs.filter(isLikelyPathToken));

  if (invocation.category === "help") {
    const segment = commandSegmentFrom(classificationTokens, 0);
    const helpIndex = segment.findIndex((token) => token === "--help" || token === "-h" || token === "help");
    const helpSubject = segment.slice(0, helpIndex === -1 ? Math.min(segment.length, 2) : helpIndex).join(" ");
    return {
      category: invocation.category,
      label: invocation.label,
      summary: helpSubject ? `Checked ${helpSubject} help` : "Checked command help",
      bucket: "run",
      quantity: 1,
      noun: "command",
    };
  }

  if (invocation.category === "install") {
    return {
      category: invocation.category,
      label: invocation.label,
      summary: "Installed packages",
      bucket: "edit",
      quantity: 1,
      noun: "item",
    };
  }

  if (invocation.category === "read") {
    const fallbackTarget = positionalArgs[positionalArgs.length - 1];
    const targets = pathTargets.length > 0
      ? pathTargets
      : fallbackTarget
        ? dedupeTargets([fallbackTarget])
        : [];
    const skillAction = formatSkillUseAction(extractSkillSlugsFromEntryPaths(targets));
    if (skillAction) {
      return {
        ...skillAction,
        category: "skill",
        label: "Use skill",
        bucket: "explore",
      };
    }
    const action = formatTargetAction("Read", targets, "file", "Read file");
    return {
      ...action,
      category: invocation.category,
      label: invocation.label,
      bucket: "explore",
    };
  }

  if (invocation.category === "list") {
    const fallbackTarget = positionalArgs[0];
    const targets = pathTargets.length > 0
      ? pathTargets
      : fallbackTarget
        ? dedupeTargets([fallbackTarget])
        : [];
    const action = formatTargetAction("Explored", targets, "location", "Explored files");
    return {
      ...action,
      category: invocation.category,
      label: invocation.label,
      bucket: "explore",
    };
  }

  if (invocation.category === "grep" || invocation.category === "search") {
    const query = positionalArgs.find((token) => !pathTargets.includes(token)) ?? null;
    return {
      category: invocation.category,
      label: invocation.label,
      summary: formatSearchActionSummary(query, pathTargets, "Searched code"),
      bucket: "search",
      quantity: 1,
      noun: "command",
    };
  }

  if (invocation.category === "edit") {
    const editSegment = findStrongEditSegment(classificationTokens) ?? classificationTokens;
    const editPositionalArgs = getShellPositionalArgsFromTokens(editSegment);
    const editPathTargets = dedupeTargets(editPositionalArgs.filter(isLikelyPathToken));
    const redirectTarget = extractStdoutWriteRedirectTarget(normalized);
    const teeTarget = editSegment[0]?.toLowerCase() === "tee" ? editPositionalArgs[0] : null;
    const fallbackTarget = redirectTarget ?? teeTarget ?? editPositionalArgs[editPositionalArgs.length - 1];
    const targetsWithoutSedExpression = commandSegmentUsesInPlaceSed(editSegment)
      ? editPathTargets.filter((target) => !isLikelySedExpressionToken(target))
      : editPathTargets;
    const targets = targetsWithoutSedExpression.length > 0
      ? targetsWithoutSedExpression
      : fallbackTarget
        ? dedupeTargets([fallbackTarget])
        : [];
    const action = formatTargetAction("Edited", targets, "file", "Edited files");
    return {
      ...action,
      category: invocation.category,
      label: invocation.label,
      bucket: "edit",
    };
  }

  if (invocation.category === "inspect") {
    let summary = "Inspected repository state";
    if (/^git\s+status\b/i.test(normalized)) {
      summary = "Inspected repository status";
    } else if (/^git\s+diff\b/i.test(normalized)) {
      summary = pathTargets[0] ? `Inspected changes in ${pathTargets[0]}` : "Inspected changes";
    } else if (/^git\s+show\b/i.test(normalized)) {
      summary = "Inspected commit details";
    }
    return {
      category: invocation.category,
      label: invocation.label,
      summary,
      bucket: "run",
      quantity: 1,
      noun: "command",
    };
  }

  return {
    category: invocation.category,
    label: invocation.label,
    summary: classificationTokens.some((token) => token === "|" || token === ";" || token === "&&" || token === "||")
      ? "Ran shell command"
      : `Ran ${truncate(summarizeCommandPhrase(command), 64)}`,
    bucket: "run",
    quantity: 1,
    noun: "command",
  };
}

export function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatToolPayload(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return formatUnknown(value);
}

export function extractToolUseId(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  const candidates = [
    record.toolUseId,
    record.tool_use_id,
    record.callId,
    record.call_id,
    record.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

export function describeToolInvocation(name: string, input: unknown): { category: TranscriptToolCategory; label: string } {
  if (isCommandTool(name, input)) {
    const command =
      typeof input === "string"
        ? input
        : (() => {
            const record = asRecord(input);
            return typeof record?.command === "string"
              ? record.command
              : typeof record?.cmd === "string"
                ? record.cmd
                : "";
          })();
    return classifyShellCommand(command);
  }

  const mcpDetails = extractMcpToolDetails(name, input);
  if (mcpDetails) {
    return { category: "mcp", label: formatMcpLabel(mcpDetails) };
  }

  if (isWebSearchTool(name, input)) {
    return { category: "web_search", label: "Web Search" };
  }

  const normalized = name.trim().toLowerCase();
  if (/(?:^|[_-])(read|fetch|open|cat)(?:$|[_-])/.test(normalized)) {
    return { category: "read", label: "Read" };
  }
  if (/(?:^|[_-])(edit|write|patch|apply)(?:$|[_-])/.test(normalized)) {
    return { category: "edit", label: "Edit" };
  }
  if (/(?:^|[_-])(grep|search|find)(?:$|[_-])/.test(normalized)) {
    return { category: normalized.includes("grep") ? "grep" : "search", label: "Search" };
  }
  if (/(?:^|[_-])(list|ls|tree)(?:$|[_-])/.test(normalized)) {
    return { category: "list", label: "Explore" };
  }
  if (/(?:^|[_-])(inspect|show|status|diff|log)(?:$|[_-])/.test(normalized)) {
    return { category: "inspect", label: "Inspect" };
  }

  return { category: "tool", label: humanizeLabel(name) };
}

export function summarizeRecord(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(compactWhitespace(value), 120);
    }
  }
  return null;
}

export function summarizeToolInput(name: string, input: unknown, density: TranscriptDensity): string {
  const compactMax = density === "compact" ? 72 : 120;
  if (typeof input === "string") {
    const normalized = isCommandTool(name, input) ? stripWrappedShell(input) : compactWhitespace(input);
    return truncate(normalized, compactMax);
  }
  const record = asRecord(input);
  if (!record) {
    const serialized = compactWhitespace(formatUnknown(input));
    return serialized ? truncate(serialized, compactMax) : `Inspect ${name} input`;
  }

  const command = typeof record.command === "string"
    ? record.command
    : typeof record.cmd === "string"
      ? record.cmd
      : null;
  if (command && isCommandTool(name, record)) {
    return truncate(stripWrappedShell(command), compactMax);
  }

  const direct =
    summarizeRecord(record, ["command", "cmd", "path", "filePath", "file_path", "query", "url", "prompt", "message"])
    ?? summarizeRecord(record, ["pattern", "name", "title", "target", "tool"])
    ?? null;
  if (direct) return truncate(direct, compactMax);

  if (Array.isArray(record.paths) && record.paths.length > 0) {
    const first = record.paths.find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (first) {
      return truncate(`${record.paths.length} paths, starting with ${first}`, compactMax);
    }
  }

  const keys = Object.keys(record);
  if (keys.length === 0) return `No ${name} input`;
  if (keys.length === 1) return truncate(`${keys[0]} payload`, compactMax);
  return truncate(`${keys.length} fields: ${keys.slice(0, 3).join(", ")}`, compactMax);
}

export function parseStructuredToolResult(result: string | undefined) {
  if (!result) return null;
  const lines = result.split(/\r?\n/);
  const metadata = new Map<string, string>();
  let bodyStartIndex = lines.findIndex((line) => line.trim() === "");
  if (bodyStartIndex === -1) bodyStartIndex = lines.length;

  for (let index = 0; index < bodyStartIndex; index += 1) {
    const match = lines[index]?.match(/^([a-z_]+):\s*(.+)$/i);
    if (match) {
      metadata.set(match[1].toLowerCase(), compactWhitespace(match[2]));
    }
  }

  const body = lines.slice(Math.min(bodyStartIndex + 1, lines.length)).join("\n").trim();

  return {
    command: metadata.get("command") ?? null,
    status: metadata.get("status") ?? null,
    exitCode: metadata.get("exit_code") ?? null,
    body,
  };
}

export function formatCommandTerminalOutput(result: string | undefined): string | null {
  if (!result) return null;
  const structured = parseStructuredToolResult(result);
  if (structured) {
    return structured.body || null;
  }
  return result;
}

export function isCommandTool(name: string, input: unknown): boolean {
  if (name === "command_execution" || name === "shell" || name === "shellToolCall" || name === "bash") {
    return true;
  }
  if (typeof input === "string") {
    return /\b(?:bash|zsh|sh|cmd|powershell)\b/i.test(input);
  }
  const record = asRecord(input);
  return Boolean(record && (typeof record.command === "string" || typeof record.cmd === "string"));
}

export function describeToolSemanticInfo(name: string, input: unknown): TranscriptToolSemanticInfo {
  const normalizedName = name.trim().toLowerCase();
  const record = asRecord(input);

  if (normalizedName === "skill") {
    const skill = readStringField(record, ["skill", "name"]);
    const skillAction = skill ? formatSkillUseAction([skill]) : null;
    return {
      category: "skill",
      label: "Use skill",
      summary: skillAction?.summary ?? "Use skill",
      bucket: "explore",
      quantity: 1,
      noun: "skill",
    };
  }

  if (isCommandTool(name, input)) {
    const command =
      typeof input === "string"
        ? input
        : (() => {
            const record = asRecord(input);
            return typeof record?.command === "string"
              ? record.command
              : typeof record?.cmd === "string"
                ? record.cmd
                : "";
          })();
    return describeCommandSemanticInfo(command);
  }

  const mcpDetails = extractMcpToolDetails(name, input);
  if (mcpDetails) {
    return {
      category: "mcp",
      label: formatMcpLabel(mcpDetails),
      summary: formatMcpSummary(mcpDetails),
      bucket: "tool",
      quantity: 1,
      noun: "tool",
    };
  }

  if (isWebSearchTool(name, input)) {
    const queries = extractWebSearchQueries(input);
    return {
      category: "web_search",
      label: "Web Search",
      summary: formatWebSearchSummary(queries),
      bucket: "search",
      quantity: Math.max(queries.length, 1),
      noun: "tool",
    };
  }

  const invocation = describeToolInvocation(name, input);
  const paths = extractRecordPaths(record);
  const query = extractRecordQuery(record);

  if (invocation.category === "read") {
    const skillAction = formatSkillUseAction(extractSkillSlugsFromEntryPaths(paths));
    if (skillAction) {
      return {
        ...skillAction,
        category: "skill",
        label: "Use skill",
        bucket: "explore",
      };
    }
    const action = formatTargetAction("Read", paths, "file", "Read file");
    return {
      ...action,
      category: invocation.category,
      label: invocation.label,
      bucket: "explore",
    };
  }

  if (invocation.category === "list") {
    const action = formatTargetAction("Explored", paths, "location", "Explored files");
    return {
      ...action,
      category: invocation.category,
      label: invocation.label,
      bucket: "explore",
    };
  }

  if (invocation.category === "grep" || invocation.category === "search") {
    return {
      category: invocation.category,
      label: invocation.label,
      summary: formatSearchActionSummary(query, paths, "Searched"),
      bucket: "search",
      quantity: 1,
      noun: "command",
    };
  }

  if (invocation.category === "edit") {
    const action = formatTargetAction("Edited", paths, "file", "Edited files");
    return {
      ...action,
      category: invocation.category,
      label: invocation.label,
      bucket: "edit",
    };
  }

  if (invocation.category === "inspect") {
    return {
      category: invocation.category,
      label: invocation.label,
      summary: paths[0] ? `Inspected ${paths[0]}` : "Inspected details",
      bucket: "run",
      quantity: 1,
      noun: "command",
    };
  }

  return {
    category: invocation.category,
    label: invocation.label,
    summary: invocation.label,
    bucket: "tool",
    quantity: 1,
    noun: "tool",
  };
}

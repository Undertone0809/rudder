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

export function decodeShellEscapes(value: string, options: { includeWhitespace?: boolean } = {}): string {
  const pattern = options.includeWhitespace ? /\\(["'`\\\s])/g : /\\(["'`\\])/g;
  return value.replace(pattern, "$1");
}

export function stripWrappedShell(command: string): string {
  const trimmed = compactWhitespace(command);
  const shellWrapped = trimmed.match(/^(?:(?:\/bin\/)?(?:zsh|bash|sh)|cmd(?:\.exe)?(?:\s+\/d)?(?:\s+\/s)?(?:\s+\/c)?)\s+(?:-lc|\/c)\s+(.+)$/i);
  const inner = shellWrapped?.[1] ?? trimmed;
  const quoted = inner.match(/^(['"])([\s\S]*)\1$/);
  return compactWhitespace(decodeShellEscapes(quoted?.[2] ?? inner));
}

export function tokenizeShellForClassification(command: string): string[] {
  const tokens = stripWrappedShell(command).match(/&&|\|\||[|;&]|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|(?:\\.|[^\s|;&])+/g) ?? [];
  return tokens.map((token) => {
    if (isShellControlToken(token)) return token;
    return unwrapQuotedToken(token).trim();
  }).filter(Boolean);
}

export function shellTokensForCommand(command: string): string[] {
  return tokenizeShellForClassification(command);
}

export function isShellControlToken(token: string): boolean {
  return /^(?:&&|\|\||[|;&])$/.test(token);
}

export function commandSegmentFrom(tokens: string[], startIndex: number): string[] {
  const segment: string[] = [];
  for (const token of tokens.slice(startIndex)) {
    if (isShellControlToken(token)) break;
    segment.push(token);
  }
  return segment;
}

export function splitShellCommandSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let segment: string[] = [];

  for (const token of tokens) {
    if (isShellControlToken(token)) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
      continue;
    }
    segment.push(token);
  }

  if (segment.length > 0) segments.push(segment);
  return segments;
}

export function hasHelpSignal(tokens: string[]): boolean {
  return tokens.some((token) => token === "--help" || token === "-h" || token === "help");
}

export function hasStdoutWriteRedirect(command: string): boolean {
  return Boolean(extractStdoutWriteRedirectTarget(stripWrappedShell(command)));
}

export function extractStdoutWriteRedirectTarget(command: string): string | null {
  const redirect = command.match(/(?:^|\s)(?:[0-9]?>{1,2}|&>)\s*([^\s|&;]+)/);
  const target = redirect?.[1] ? cleanShellToken(redirect[1]) : null;
  return target && target !== "/dev/null" ? target : null;
}

export function extractStdoutWriteRedirectTargetFromTokens(tokens: string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^(?:[0-9]?>{1,2}|&>)$/.test(token)) {
      const target = tokens[index + 1] ? cleanShellToken(tokens[index + 1]) : null;
      if (target && target !== "/dev/null") return target;
      continue;
    }
    const attachedRedirect = token.match(/^(?:[0-9]?>{1,2}|&>)(.+)$/);
    const target = attachedRedirect?.[1] ? cleanShellToken(attachedRedirect[1]) : null;
    if (target && target !== "/dev/null") return target;
  }
  return null;
}

export function commandSegmentHasStdoutWriteRedirect(segment: string[]): boolean {
  return Boolean(extractStdoutWriteRedirectTargetFromTokens(segment));
}

export function commandUsesInPlaceSed(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "sed") continue;
    const segment = commandSegmentFrom(tokens, index + 1);
    if (segment.some((token) => token === "--in-place" || token.startsWith("--in-place=") || /^-[^-]*i/.test(token))) {
      return true;
    }
  }
  return false;
}

export function commandUsesInPlacePerl(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "perl") continue;
    const segment = commandSegmentFrom(tokens, index + 1);
    if (segment.some((token) => /^-[^-]*p[^-]*i|^-[^-]*i[^-]*p/.test(token))) {
      return true;
    }
  }
  return false;
}

export function isPackageInstallCommand(firstToken: string, tokens: string[]): boolean {
  const command = firstToken.toLowerCase();
  const args = commandSegmentFrom(tokens, 1).filter((token) => token !== "--" && !token.startsWith("-"));
  const action = args[0]?.toLowerCase();
  if (!action) return false;

  if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
    return action === "install" || action === "i" || action === "add";
  }
  if (["pip", "pip3", "uv", "poetry"].includes(command)) {
    return action === "install" || action === "add";
  }
  if (command === "bundle") return action === "install" || action === "add";
  if (command === "composer") return action === "install" || action === "require";
  return false;
}

export function commandSegmentUsesInPlaceSed(segment: string[]): boolean {
  const command = segment[0]?.toLowerCase();
  if (command !== "sed") return false;
  return segment.slice(1).some((token) => token === "--in-place" || token.startsWith("--in-place=") || /^-[^-]*i/.test(token));
}

export function commandSegmentUsesInPlacePerl(segment: string[]): boolean {
  const command = segment[0]?.toLowerCase();
  if (command !== "perl") return false;
  return segment.slice(1).some((token) => /^-[^-]*p[^-]*i|^-[^-]*i[^-]*p/.test(token));
}

export function findStrongEditSegment(tokens: string[]): string[] | null {
  for (const segment of splitShellCommandSegments(tokens)) {
    const command = segment[0]?.toLowerCase();
    if (!command) continue;
    if (STRONG_WRITE_COMMAND_TOKENS.has(command)) return segment;
    if (commandSegmentUsesInPlaceSed(segment) || commandSegmentUsesInPlacePerl(segment)) return segment;
    if (commandSegmentHasStdoutWriteRedirect(segment)) return segment;
  }
  return null;
}

export function hasPackageInstallSegment(tokens: string[]): boolean {
  return splitShellCommandSegments(tokens).some((segment) => {
    const command = segment[0]?.toLowerCase();
    return Boolean(command && isPackageInstallCommand(command, segment));
  });
}

export function getShellPositionalArgsFromTokens(tokens: string[]): string[] {
  const positional: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^(?:&&|\|\||[|;])$/.test(token)) break;
    if (/^(?:[0-9]?>{1,2}|&>)$/.test(token)) {
      index += 1;
      continue;
    }
    if (/^(?:[0-9]?>{1,2}|&>).+/.test(token)) continue;
    if (token === "--") continue;
    if (token.startsWith("-")) continue;
    positional.push(token);
  }

  return positional;
}

export function classifyShellCommand(command: string): { category: TranscriptToolCategory; label: string } {
  const normalized = stripWrappedShell(command);
  const tokens = shellTokensForCommand(command);
  const firstToken = tokens[0]?.toLowerCase() ?? "";
  const normalizedLower = normalized.toLowerCase();
  const strongEditSegment = findStrongEditSegment(tokens);

  if (!firstToken) {
    return { category: "bash", label: "Command" };
  }

  if (strongEditSegment || commandUsesInPlaceSed(tokens) || commandUsesInPlacePerl(tokens) || hasStdoutWriteRedirect(command)) {
    return { category: "edit", label: "Edit" };
  }

  if (hasPackageInstallSegment(tokens)) {
    return { category: "install", label: "Install" };
  }

  if (hasHelpSignal(commandSegmentFrom(tokens, 0))) {
    return { category: "help", label: "Help" };
  }

  if (firstToken === "rg" && /\s--files(?:\s|$)/.test(normalizedLower)) {
    return { category: "list", label: "Explore" };
  }
  if (firstToken === "rg" || firstToken === "grep") {
    return { category: "grep", label: "Search" };
  }
  if (firstToken === "find" || firstToken === "fd" || firstToken === "fzf") {
    return { category: "list", label: "Explore" };
  }
  if (firstToken === "ls" || firstToken === "tree") {
    return { category: "list", label: "Explore" };
  }
  if (
    firstToken === "sed" ||
    firstToken === "cat" ||
    firstToken === "head" ||
    firstToken === "tail" ||
    firstToken === "less" ||
    firstToken === "more" ||
    firstToken === "awk" ||
    firstToken === "jq" ||
    firstToken === "cut" ||
    firstToken === "tr" ||
    firstToken === "sort" ||
    firstToken === "uniq" ||
    firstToken === "wc"
  ) {
    return { category: "read", label: "Read" };
  }
  if (firstToken === "git") {
    if (/\b(diff|show|status|log|blame|grep)\b/.test(normalizedLower)) {
      return { category: "inspect", label: "Inspect" };
    }
    return { category: "bash", label: "Command" };
  }
  if (
    [
      "pnpm",
      "npm",
      "yarn",
      "bun",
      "node",
      "nodejs",
      "npx",
      "tsx",
      "ts-node",
      "deno",
      "python",
      "python3",
      "pytest",
      "vitest",
      "jest",
      "go",
      "cargo",
      "make",
      "gradle",
      "mvn",
      "poetry",
      "uv",
      "bundle",
      "ruby",
      "php",
      "composer",
      "ruff",
      "black",
      "eslint",
      "prettier",
    ].includes(firstToken)
  ) {
    return { category: "script", label: "Command" };
  }

  return { category: "bash", label: "Command" };
}

export function unwrapQuotedToken(token: string): string {
  const trimmed = token.trim();
  const quoted = trimmed.match(/^(['"`])([\s\S]*)\1$/);
  return decodeShellEscapes(quoted ? quoted[2] : trimmed, { includeWhitespace: true });
}

export function cleanShellToken(token: string): string {
  return unwrapQuotedToken(token).replace(/[;,|&]+$/g, "").trim();
}

export function normalizeTranscriptPathToken(value: string): string {
  return cleanShellToken(value)
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .trim();
}

export function titleCaseAgentSlug(value: string): string {
  const base = value.split("--")[0] || value;
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function inferAgentNameFromMemoryPath(path: string): string | null {
  const normalized = normalizeTranscriptPathToken(path);
  const match = normalized.match(/\/workspaces\/agents\/([^/]+)/i);
  const slug = match?.[1];
  return slug ? titleCaseAgentSlug(slug) : null;
}

export function classifyAgentMemoryPath(path: string): TranscriptMemoryScope | null {
  const normalized = normalizeTranscriptPathToken(path);
  const lower = normalized.toLowerCase();
  const hasAgentHomeSignal =
    lower.startsWith("$agent_home/")
    || lower.includes("/.rudder/instances/")
    || lower.includes("/workspaces/agents/")
    || lower.includes("/agents/");
  const isRelativeStableMemory = /^(?:\.\/)?instructions\/memory\.md$/i.test(normalized);
  const isRelativeDailyMemory = /^(?:\.\/)?memory\/[^/]+/i.test(normalized);
  const isRelativeKnowledgeGraph = /^(?:\.\/)?life\/[^/]+/i.test(normalized);

  if ((hasAgentHomeSignal || isRelativeStableMemory) && /(?:^|\/)instructions\/memory\.md$/i.test(normalized)) {
    return "stable_instructions";
  }
  if ((hasAgentHomeSignal || isRelativeDailyMemory) && /(?:^|\/)memory\/[^/]+/i.test(normalized)) {
    return "daily_note";
  }
  if ((hasAgentHomeSignal || isRelativeKnowledgeGraph) && /(?:^|\/)life\/[^/]+/i.test(normalized)) {
    return "knowledge_graph";
  }
  return null;
}

export function formatMemoryScopeLabel(scope: TranscriptMemoryScope): string {
  switch (scope) {
    case "stable_instructions":
      return "Stable instructions";
    case "daily_note":
      return "Daily note";
    case "knowledge_graph":
      return "Knowledge graph";
    default:
      return "Agent memory";
  }
}

export function formatMemoryScopeSummary(scope: TranscriptMemoryScope): string {
  switch (scope) {
    case "stable_instructions":
      return "stable memory instructions";
    case "daily_note":
      return "daily memory note";
    case "knowledge_graph":
      return "knowledge graph memory";
    default:
      return "agent memory";
  }
}

export function formatMemoryEffect(scope: TranscriptMemoryScope): string {
  return scope === "stable_instructions" ? "Effective next run" : "Effective immediately";
}

export function formatMemoryOperation(value: string, status: "completed" | "error"): string {
  if (status === "error") return "failed to update";
  const normalized = value.trim().toLowerCase();
  if (normalized === "add" || normalized === "create" || normalized === "created") return "created";
  if (normalized === "delete" || normalized === "remove" || normalized === "removed") return "removed";
  return "updated";
}

export function splitFileChangeEntries(value: string): string[] {
  return value
    .replace(/\s*\(\+\d+\s+more\)\s*$/i, "")
    .split(/,\s+(?=(?:add|create|created|update|updated|modify|modified|delete|remove|removed)\s+)/i)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function extractMemoryUpdateFailureReason(text: string, body: string): string | undefined {
  if (!/\b(?:failed|error|errored)\b/i.test(text)) return undefined;
  const withoutChanges = body.replace(/^(?:add|create|created|update|updated|modify|modified|delete|remove|removed)\s+\S+\s*/i, "").trim();
  return withoutChanges || compactWhitespace(text);
}

export function parseMemoryUpdateSystemText(text: string, ts: string): Extract<TranscriptBlock, { type: "memory_update" }> | null {
  const trimmed = compactWhitespace(text);
  const match =
    trimmed.match(/^file changes:\s*(.+)$/i)
    ?? trimmed.match(/^file_change:\s*(.+)$/i)
    ?? trimmed.match(/^file changes failed:\s*(.+)$/i)
    ?? trimmed.match(/^memory update failed:\s*(.+)$/i);
  if (!match) return null;

  const status: "completed" | "error" = /\b(?:failed|error|errored)\b/i.test(trimmed) ? "error" : "completed";
  const changes = splitFileChangeEntries(match[1] ?? "")
    .map((entry) => {
      const changeMatch = entry.match(/^(add|create|created|update|updated|modify|modified|delete|remove|removed)\s+(.+)$/i);
      if (!changeMatch) return null;
      const path = normalizeTranscriptPathToken(changeMatch[2] ?? "");
      const scope = classifyAgentMemoryPath(path);
      if (!scope) return null;
      return {
        operation: changeMatch[1] ?? "update",
        path,
        scope,
      } satisfies TranscriptMemoryUpdateChange;
    })
    .filter((change): change is TranscriptMemoryUpdateChange => Boolean(change));

  if (changes.length === 0) return null;

  const primaryChange = changes[0]!;
  const agentName = changes.map((change) => inferAgentNameFromMemoryPath(change.path)).find(Boolean) ?? null;
  const scopes = [...new Set(changes.map((change) => change.scope))];
  const scope = scopes.length === 1 ? primaryChange.scope : "knowledge_graph";
  const scopeSummary = scopes.length === 1 ? formatMemoryScopeSummary(primaryChange.scope) : "agent memory";
  const operation = formatMemoryOperation(primaryChange.operation, status);
  const actor = agentName ?? "Agent";
  const summary = `${actor} ${operation} ${scopeSummary}.`;

  return {
    type: "memory_update",
    ts,
    status,
    agentName,
    scope,
    changes,
    summary,
    effect: formatMemoryEffect(primaryChange.scope),
    rawText: text,
    failureReason: extractMemoryUpdateFailureReason(trimmed, match[1] ?? ""),
  };
}

export function tokenizeShell(command: string): string[] {
  const tokens = stripWrappedShell(command).match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|(?:\\.|[^\s])+/g) ?? [];
  return tokens.map(cleanShellToken).filter(Boolean);
}

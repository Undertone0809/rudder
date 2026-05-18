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

export type TranscriptMode = "nice" | "raw";
export type TranscriptDensity = "comfortable" | "compact";
export type TranscriptPresentation = "default" | "chat" | "detail";

type TranscriptToolCategory =
  | "tool"
  | "bash"
  | "script"
  | "help"
  | "install"
  | "read"
  | "edit"
  | "grep"
  | "search"
  | "web_search"
  | "skill"
  | "mcp"
  | "list"
  | "inspect";

type TranscriptDigestBucket =
  | "explore"
  | "search"
  | "edit"
  | "run"
  | "tool";

type TranscriptActionIconCategory = TranscriptToolCategory | "stdout" | "memory";
type TranscriptActionIconStatus = "running" | "completed" | "error" | "neutral";

interface TranscriptActionIconTreatment {
  key: string;
  label: string;
  Icon: LucideIcon;
}

interface TranscriptToolSemanticInfo {
  category: TranscriptToolCategory;
  label: string;
  summary: string;
  bucket: TranscriptDigestBucket;
  quantity: number;
  noun: "file" | "location" | "item" | "tool" | "command" | "skill";
}

interface TranscriptToolCardEntry {
  ts: string;
  endTs?: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: "running" | "completed" | "error";
}

type TranscriptMemoryScope = "stable_instructions" | "daily_note" | "knowledge_graph";

interface TranscriptMemoryUpdateChange {
  operation: string;
  path: string;
  scope: TranscriptMemoryScope;
}

type TranscriptTodoListItem = Extract<TranscriptEntry, { kind: "todo_list" }>["items"][number];

interface RunTranscriptViewProps {
  entries: TranscriptEntry[];
  mode?: TranscriptMode;
  density?: TranscriptDensity;
  limit?: number;
  streaming?: boolean;
  collapseStdout?: boolean;
  emptyMessage?: string;
  className?: string;
  thinkingClassName?: string;
  /** Chat stream: denser rows, collapsible thinking summaries, tool cards stay expandable. */
  presentation?: TranscriptPresentation;
  /** Show Rudder-internal runtime/session/workspace diagnostics that are hidden from the default operator view. */
  showDeveloperDiagnostics?: boolean;
  /** For embedded chat process logs, the final assistant answer is rendered as the message body. */
  hideAssistantMessages?: boolean;
  /** For embedded chat process logs, remove only the final answer suffix while keeping progress notes visible. */
  hiddenAssistantMessageText?: string | null;
}

type TranscriptBlock =
  | {
      type: "message";
      role: "assistant" | "user";
      ts: string;
      text: string;
      streaming: boolean;
    }
  | {
      type: "thinking";
      ts: string;
      text: string;
      streaming: boolean;
    }
  | {
      type: "tool";
      ts: string;
      endTs?: string;
      name: string;
      toolUseId?: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      status: "running" | "completed" | "error";
    }
  | {
      type: "activity";
      ts: string;
      activityId?: string;
      name: string;
      status: "running" | "completed";
    }
  | {
      type: "todo_list";
      ts: string;
      todoListId?: string;
      items: TranscriptTodoListItem[];
    }
  | {
      type: "command_group";
      ts: string;
      endTs?: string;
      items: Array<TranscriptToolCardEntry>;
    }
  | {
      type: "stdout";
      ts: string;
      text: string;
    }
  | {
      type: "memory_update";
      ts: string;
      status: "completed" | "error";
      agentName: string | null;
      scope: TranscriptMemoryScope;
      changes: TranscriptMemoryUpdateChange[];
      summary: string;
      effect: string;
      rawText: string;
      failureReason?: string;
    }
  | {
      type: "event";
      ts: string;
      label: string;
      tone: "info" | "warn" | "error" | "neutral";
      text: string;
      detail?: string;
      collapseByDefault?: boolean;
    };

interface ChatTranscriptTurn {
  key: string;
  index: number;
  ts: string;
  blocks: TranscriptBlock[];
  commandCount: number;
  toolCount: number;
  stdoutCount: number;
  hasRunning: boolean;
  hasError: boolean;
  preview: string | null;
}

type ChatTranscriptAction =
  | {
      key: string;
      type: "tool";
      entry: TranscriptToolCardEntry;
    }
  | {
      key: string;
      type: "stdout";
      entry: Extract<TranscriptBlock, { type: "stdout" }>;
    };

const COMMON_FILENAME_TOKENS = new Set([
  "README",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "playwright.config.ts",
  "Dockerfile",
  "Makefile",
  "LICENSE",
]);
const STRONG_WRITE_COMMAND_TOKENS = new Set(["apply_patch", "patch", "ed", "tee", "mv", "cp", "rm", "mkdir", "touch"]);
const LONG_EVENT_COLLAPSE_CHARS = 900;
const LONG_EVENT_COLLAPSE_LINES = 8;
const LOCAL_POSIX_FILE_ROOTS = [
  "/Users/",
  "/home/",
  "/Volumes/",
  "/tmp/",
  "/var/",
  "/opt/",
  "/mnt/",
  "/private/",
];

type TranscriptMarkdownLinkClickHandler = MarkdownLinkClickHandler;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function decodeFileUrlPath(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:") return null;
    const pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1);
    return pathname;
  } catch {
    return null;
  }
}

export function resolveTranscriptLocalFileTarget(href: string | null | undefined): string | null {
  const value = href?.trim();
  if (!value) return null;

  const fileUrlPath = /^file:/i.test(value) ? decodeFileUrlPath(value) : null;
  if (fileUrlPath) return fileUrlPath;

  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  if (/^\\\\[^\\]+\\[^\\]+/.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (value.startsWith("//")) return null;
  if (LOCAL_POSIX_FILE_ROOTS.some((root) => value.startsWith(root))) return value;
  return null;
}

function shouldHandlePlainClick(event: Parameters<MarkdownLinkClickHandler>[0]["event"]) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isTurnStartedText(value: string): boolean {
  return compactWhitespace(value).toLowerCase() === "turn started";
}

function isRudderDeveloperDiagnosticLine(trimmed: string): boolean {
  if (/^\[rudder\](?:\s|$)/.test(trimmed)) return true;
  return false;
}

function isRudderDeveloperDiagnosticContinuationLine(trimmed: string): boolean {
  return /^[\s./~,-]/.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed);
}

function filterRoutineStdout(value: string, showDeveloperDiagnostics: boolean): string {
  if (showDeveloperDiagnostics) return value.trim();
  let suppressRudderContinuation = false;
  return value
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (isRudderDeveloperDiagnosticLine(trimmed)) {
        suppressRudderContinuation = /:\s*$/.test(trimmed);
        return false;
      }
      if (suppressRudderContinuation && isRudderDeveloperDiagnosticContinuationLine(trimmed)) {
        return false;
      }
      suppressRudderContinuation = false;
      return true;
    })
    .join("\n")
    .trim();
}

function isWarningStderrLine(line: string): boolean {
  const trimmed = line.trim();
  return /^WARN\b/i.test(trimmed) || /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+/i.test(trimmed);
}

function isAnalyticsForbiddenHtmlStart(line: string): boolean {
  return /WARN\s+codex_analytics::analytics_client:\s+events failed with status 403 Forbidden:\s+<html>/i.test(line.trim());
}

function filterRenderableTranscriptEntries(
  entries: TranscriptEntry[],
  options?: { showDeveloperDiagnostics?: boolean },
): TranscriptEntry[] {
  if (options?.showDeveloperDiagnostics) return entries;
  let suppressingWarningHtml = false;
  const result: TranscriptEntry[] = [];

  for (const entry of entries) {
    if (entry.kind === "init") continue;

    if (entry.kind !== "stderr") {
      result.push(entry);
      continue;
    }

    const keptLines: string[] = [];
    let suppressingRudderContinuation = false;
    for (const line of entry.text.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (suppressingWarningHtml) {
        if (/^<\/html>$/i.test(trimmed)) suppressingWarningHtml = false;
        continue;
      }

      if (isAnalyticsForbiddenHtmlStart(trimmed)) {
        suppressingWarningHtml = true;
        continue;
      }

      if (isRudderDeveloperDiagnosticLine(trimmed)) {
        suppressingRudderContinuation = /:\s*$/.test(trimmed);
        continue;
      }
      if (suppressingRudderContinuation && isRudderDeveloperDiagnosticContinuationLine(trimmed)) {
        continue;
      }
      suppressingRudderContinuation = false;
      if (isWarningStderrLine(trimmed)) continue;
      keptLines.push(line);
    }

    const text = stripBenignStderr(keptLines.join("\n"));
    if (text) result.push({ ...entry, text });
  }

  return result;
}

function shouldCollapseEventText(text: string): boolean {
  return text.length > LONG_EVENT_COLLAPSE_CHARS || text.split(/\r?\n/).length > LONG_EVENT_COLLAPSE_LINES;
}

function formatTranscriptTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function getTranscriptActionIconTreatment(category: TranscriptActionIconCategory): TranscriptActionIconTreatment {
  switch (category) {
    case "read":
      return { key: "read", label: "Read file", Icon: FileText };
    case "grep":
    case "search":
      return { key: "search", label: "Search", Icon: Search };
    case "web_search":
      return { key: "web_search", label: "Web search", Icon: Globe };
    case "skill":
      return { key: "skill", label: "Skill", Icon: Boxes };
    case "edit":
      return { key: "edit", label: "Edit", Icon: FileDiff };
    case "inspect":
      return { key: "inspect", label: "Inspect", Icon: ListTree };
    case "list":
      return { key: "list", label: "Explore files", Icon: FolderOpen };
    case "mcp":
      return { key: "mcp", label: "MCP tool", Icon: Plug };
    case "stdout":
      return { key: "stdout", label: "Output", Icon: Logs };
    case "memory":
      return { key: "memory", label: "Agent memory", Icon: FileText };
    case "help":
      return { key: "help", label: "Help", Icon: FileSearch };
    case "tool":
      return { key: "tool", label: "Tool", Icon: Wrench };
    case "bash":
    case "script":
    case "install":
    default:
      return { key: "command", label: "Command", Icon: TerminalSquare };
  }
}

function getTranscriptActionIconTone(status: TranscriptActionIconStatus, category: TranscriptActionIconCategory): string {
  if (status === "error") return "text-red-600 dark:text-red-300";
  if (status === "running") return "text-cyan-600 dark:text-cyan-300";
  if (category === "skill") return "text-[#2f80ed]";
  return "text-muted-foreground";
}

function TranscriptActionIcon({
  category,
  status,
  className,
}: {
  category: TranscriptActionIconCategory;
  status: TranscriptActionIconStatus;
  className?: string;
}) {
  const treatment = getTranscriptActionIconTreatment(category);
  const Icon = treatment.Icon;

  return (
    <span
      data-transcript-action-icon={treatment.key}
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center",
        getTranscriptActionIconTone(status, category),
        status === "running" && "animate-pulse",
        className,
      )}
      aria-label={treatment.label}
      title={treatment.label}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

function TranscriptActionIconSlot({
  category,
  status,
  className,
}: {
  category: TranscriptActionIconCategory;
  status: TranscriptActionIconStatus;
  className?: string;
}) {
  return (
    <span
      className={cn("relative mt-0.5 h-5 w-8 shrink-0", className)}
      data-transcript-action-icon-slot="true"
    >
      <TranscriptActionIcon category={category} status={status} className="absolute left-0 top-0.5" />
    </span>
  );
}

function TranscriptActionIconStack({
  icons,
  highlightError = false,
}: {
  icons: Array<{
    category: TranscriptActionIconCategory;
    status: TranscriptActionIconStatus;
  }>;
  highlightError?: boolean;
}) {
  const visibleIcons = icons.slice(0, 3);
  const offsetClass = (index: number) => (index === 0 ? "left-0" : index === 1 ? "left-1.5" : "left-3");

  return (
    <span
      className="relative mt-0.5 h-5 w-8 shrink-0"
      data-transcript-action-icon-slot="true"
      data-transcript-action-group-icon-slot="true"
    >
      {visibleIcons.map((icon, index) => (
        <span
          key={index}
          className={cn(
            "absolute top-0 inline-flex h-5 w-5 items-center justify-center rounded-full border",
            offsetClass(index),
            highlightError
              ? "border-red-500/20 bg-red-500/[0.08] text-red-700 dark:text-red-300"
              : icon.status === "error"
                ? "border-border/60 bg-background/80"
                : icon.status === "running"
                  ? "border-cyan-500/20 bg-cyan-500/[0.08] text-cyan-700 dark:text-cyan-300"
                  : "border-border/60 bg-background/80 text-muted-foreground",
          )}
        >
          <TranscriptActionIcon category={icon.category} status={highlightError ? "error" : icon.status} />
        </span>
      ))}
    </span>
  );
}

function getTranscriptTimestampTitle(ts: string): string | undefined {
  return formatTranscriptTimestamp(ts) || undefined;
}

function formatTranscriptDuration(startTs: string, endTs?: string): string | null {
  if (!endTs) return null;
  const start = new Date(startTs).getTime();
  const end = new Date(endTs).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const totalMs = end - start;
  if (totalMs < 1000) return `${totalMs}ms`;
  if (totalMs < 60_000) {
    const seconds = totalMs / 1000;
    return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.round((totalMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  if (word.endsWith("ch") || word.endsWith("sh")) return `${word}es`;
  if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function decodeShellEscapes(value: string, options: { includeWhitespace?: boolean } = {}): string {
  const pattern = options.includeWhitespace ? /\\(["'`\\\s])/g : /\\(["'`\\])/g;
  return value.replace(pattern, "$1");
}

function stripWrappedShell(command: string): string {
  const trimmed = compactWhitespace(command);
  const shellWrapped = trimmed.match(/^(?:(?:\/bin\/)?(?:zsh|bash|sh)|cmd(?:\.exe)?(?:\s+\/d)?(?:\s+\/s)?(?:\s+\/c)?)\s+(?:-lc|\/c)\s+(.+)$/i);
  const inner = shellWrapped?.[1] ?? trimmed;
  const quoted = inner.match(/^(['"])([\s\S]*)\1$/);
  return compactWhitespace(decodeShellEscapes(quoted?.[2] ?? inner));
}

function tokenizeShellForClassification(command: string): string[] {
  const tokens = stripWrappedShell(command).match(/&&|\|\||[|;&]|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|(?:\\.|[^\s|;&])+/g) ?? [];
  return tokens.map((token) => {
    if (isShellControlToken(token)) return token;
    return unwrapQuotedToken(token).trim();
  }).filter(Boolean);
}

function shellTokensForCommand(command: string): string[] {
  return tokenizeShellForClassification(command);
}

function isShellControlToken(token: string): boolean {
  return /^(?:&&|\|\||[|;&])$/.test(token);
}

function commandSegmentFrom(tokens: string[], startIndex: number): string[] {
  const segment: string[] = [];
  for (const token of tokens.slice(startIndex)) {
    if (isShellControlToken(token)) break;
    segment.push(token);
  }
  return segment;
}

function splitShellCommandSegments(tokens: string[]): string[][] {
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

function hasHelpSignal(tokens: string[]): boolean {
  return tokens.some((token) => token === "--help" || token === "-h" || token === "help");
}

function hasStdoutWriteRedirect(command: string): boolean {
  return Boolean(extractStdoutWriteRedirectTarget(stripWrappedShell(command)));
}

function extractStdoutWriteRedirectTarget(command: string): string | null {
  const redirect = command.match(/(?:^|\s)(?:[0-9]?>{1,2}|&>)\s*([^\s|&;]+)/);
  const target = redirect?.[1] ? cleanShellToken(redirect[1]) : null;
  return target && target !== "/dev/null" ? target : null;
}

function extractStdoutWriteRedirectTargetFromTokens(tokens: string[]): string | null {
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

function commandSegmentHasStdoutWriteRedirect(segment: string[]): boolean {
  return Boolean(extractStdoutWriteRedirectTargetFromTokens(segment));
}

function commandUsesInPlaceSed(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "sed") continue;
    const segment = commandSegmentFrom(tokens, index + 1);
    if (segment.some((token) => token === "--in-place" || token.startsWith("--in-place=") || /^-[^-]*i/.test(token))) {
      return true;
    }
  }
  return false;
}

function commandUsesInPlacePerl(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "perl") continue;
    const segment = commandSegmentFrom(tokens, index + 1);
    if (segment.some((token) => /^-[^-]*p[^-]*i|^-[^-]*i[^-]*p/.test(token))) {
      return true;
    }
  }
  return false;
}

function isPackageInstallCommand(firstToken: string, tokens: string[]): boolean {
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

function commandSegmentUsesInPlaceSed(segment: string[]): boolean {
  const command = segment[0]?.toLowerCase();
  if (command !== "sed") return false;
  return segment.slice(1).some((token) => token === "--in-place" || token.startsWith("--in-place=") || /^-[^-]*i/.test(token));
}

function commandSegmentUsesInPlacePerl(segment: string[]): boolean {
  const command = segment[0]?.toLowerCase();
  if (command !== "perl") return false;
  return segment.slice(1).some((token) => /^-[^-]*p[^-]*i|^-[^-]*i[^-]*p/.test(token));
}

function findStrongEditSegment(tokens: string[]): string[] | null {
  for (const segment of splitShellCommandSegments(tokens)) {
    const command = segment[0]?.toLowerCase();
    if (!command) continue;
    if (STRONG_WRITE_COMMAND_TOKENS.has(command)) return segment;
    if (commandSegmentUsesInPlaceSed(segment) || commandSegmentUsesInPlacePerl(segment)) return segment;
    if (commandSegmentHasStdoutWriteRedirect(segment)) return segment;
  }
  return null;
}

function hasPackageInstallSegment(tokens: string[]): boolean {
  return splitShellCommandSegments(tokens).some((segment) => {
    const command = segment[0]?.toLowerCase();
    return Boolean(command && isPackageInstallCommand(command, segment));
  });
}

function getShellPositionalArgsFromTokens(tokens: string[]): string[] {
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

function classifyShellCommand(command: string): { category: TranscriptToolCategory; label: string } {
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

function unwrapQuotedToken(token: string): string {
  const trimmed = token.trim();
  const quoted = trimmed.match(/^(['"`])([\s\S]*)\1$/);
  return decodeShellEscapes(quoted ? quoted[2] : trimmed, { includeWhitespace: true });
}

function cleanShellToken(token: string): string {
  return unwrapQuotedToken(token).replace(/[;,|&]+$/g, "").trim();
}

function normalizeTranscriptPathToken(value: string): string {
  return cleanShellToken(value)
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .trim();
}

function titleCaseAgentSlug(value: string): string {
  const base = value.split("--")[0] || value;
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferAgentNameFromMemoryPath(path: string): string | null {
  const normalized = normalizeTranscriptPathToken(path);
  const match = normalized.match(/\/workspaces\/agents\/([^/]+)/i);
  const slug = match?.[1];
  return slug ? titleCaseAgentSlug(slug) : null;
}

function classifyAgentMemoryPath(path: string): TranscriptMemoryScope | null {
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

function formatMemoryScopeLabel(scope: TranscriptMemoryScope): string {
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

function formatMemoryScopeSummary(scope: TranscriptMemoryScope): string {
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

function formatMemoryEffect(scope: TranscriptMemoryScope): string {
  return scope === "stable_instructions" ? "Effective next run" : "Effective immediately";
}

function formatMemoryOperation(value: string, status: "completed" | "error"): string {
  if (status === "error") return "failed to update";
  const normalized = value.trim().toLowerCase();
  if (normalized === "add" || normalized === "create" || normalized === "created") return "created";
  if (normalized === "delete" || normalized === "remove" || normalized === "removed") return "removed";
  return "updated";
}

function splitFileChangeEntries(value: string): string[] {
  return value
    .replace(/\s*\(\+\d+\s+more\)\s*$/i, "")
    .split(/,\s+(?=(?:add|create|created|update|updated|modify|modified|delete|remove|removed)\s+)/i)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractMemoryUpdateFailureReason(text: string, body: string): string | undefined {
  if (!/\b(?:failed|error|errored)\b/i.test(text)) return undefined;
  const withoutChanges = body.replace(/^(?:add|create|created|update|updated|modify|modified|delete|remove|removed)\s+\S+\s*/i, "").trim();
  return withoutChanges || compactWhitespace(text);
}

function parseMemoryUpdateSystemText(text: string, ts: string): Extract<TranscriptBlock, { type: "memory_update" }> | null {
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

function tokenizeShell(command: string): string[] {
  const tokens = stripWrappedShell(command).match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|(?:\\.|[^\s])+/g) ?? [];
  return tokens.map(cleanShellToken).filter(Boolean);
}

function normalizePathTarget(value: string): string | null {
  const normalized = cleanShellToken(compactWhitespace(value));
  if (!normalized) return null;
  if (/^(?:&&|\|\||[|;<>])$/.test(normalized)) return null;
  return normalized;
}

function dedupeTargets(values: string[]): string[] {
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

function extractSkillSlugFromEntryPath(value: string): string | null {
  const normalized = normalizePathTarget(value)?.replace(/\\/g, "/");
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2 || parts[parts.length - 1] !== "SKILL.md") return null;
  const slug = parts[parts.length - 2];
  if (!slug || slug === "." || slug === "..") return null;
  return slug;
}

function extractSkillSlugsFromEntryPaths(values: string[]): string[] {
  return dedupeTargets(values.flatMap((value) => {
    const slug = extractSkillSlugFromEntryPath(value);
    return slug ? [slug] : [];
  }));
}

function formatSkillUseAction(slugs: string[]): Pick<TranscriptToolSemanticInfo, "summary" | "quantity" | "noun"> | null {
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

function isLikelyPathToken(token: string): boolean {
  const value = normalizePathTarget(token);
  if (!value || value.startsWith("-")) return false;
  if (/[{}[\]$]/.test(value)) return false;
  if (value.includes("/") || value.startsWith(".") || value.startsWith("~")) return true;
  if (COMMON_FILENAME_TOKENS.has(value)) return true;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/.test(value)) return true;
  return false;
}

function isLikelySedExpressionToken(token: string): boolean {
  const value = normalizePathTarget(token);
  return Boolean(value && /^(?:s|y|tr)\/.*\/[a-z]*$/i.test(value));
}

function getShellPositionalArgs(command: string): string[] {
  return getShellPositionalArgsFromTokens(tokenizeShell(command));
}

function extractRecordPaths(record: Record<string, unknown> | null): string[] {
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

function extractRecordQuery(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  for (const key of ["query", "pattern", "search", "q", "text", "prompt", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return compactWhitespace(value);
    }
  }
  return null;
}

function readStringField(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return compactWhitespace(value);
    }
  }
  return null;
}

function extractQueryValues(value: unknown): string[] {
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

function extractWebSearchQueries(input: unknown): string[] {
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

function isWebSearchTool(name: string, input: unknown): boolean {
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

function formatWebSearchSummary(queries: string[]): string {
  if (queries.length === 1) return `Web searched ${quoteSummaryText(queries[0]!)}`;
  if (queries.length > 1) return `Web searched ${queries.length} queries: ${queries.slice(0, 2).map((query) => quoteSummaryText(query, 32)).join(", ")}`;
  return "Web searched";
}

interface McpToolDetails {
  server: string | null;
  tool: string | null;
  args: Record<string, unknown> | null;
}

const MCP_METADATA_KEYS = new Set([
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

function parseMcpToolName(name: string): Pick<McpToolDetails, "server" | "tool"> | null {
  const parts = name.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") {
    return {
      server: parts[1] || null,
      tool: parts.slice(2).join("__") || null,
    };
  }
  return null;
}

function sanitizeMcpArgs(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) return null;
  const args = Object.fromEntries(
    Object.entries(record).filter(([key, value]) => !MCP_METADATA_KEYS.has(key) && value !== undefined && value !== null && value !== ""),
  );
  return Object.keys(args).length > 0 ? args : null;
}

function extractMcpToolDetails(name: string, input: unknown): McpToolDetails | null {
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

function summarizeMcpValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return truncate(compactWhitespace(value), 40);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const firstString = value.find((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (firstString) return `${value.length} items, starting with ${truncate(compactWhitespace(firstString), 28)}`;
    if (value.length > 0) return `${value.length} items`;
  }
  return null;
}

function summarizeMcpArgs(args: Record<string, unknown> | null): string | null {
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

function formatMcpLabel(details: McpToolDetails): string {
  return details.server ? `MCP · ${humanizeLabel(details.server)}` : "MCP";
}

function formatMcpSummary(details: McpToolDetails): string {
  const tool = details.tool ?? "tool";
  const server = details.server ? ` via ${details.server}` : "";
  const args = summarizeMcpArgs(details.args);
  return `Called ${tool}${server}${args ? ` · ${args}` : ""}`;
}

function formatTargetAction(
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

function quoteSummaryText(value: string, max = 48): string {
  return `"${truncate(compactWhitespace(value), max)}"`;
}

function formatSearchActionSummary(query: string | null, targets: string[], fallback: string): string {
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

function summarizeCommandPhrase(command: string): string {
  const tokens = tokenizeShell(command);
  if (tokens.length === 0) return "command";
  const phrase = tokens.slice(0, 3).join(" ");
  return tokens.length > 3 ? `${phrase}…` : phrase;
}

function extractShellFlagValue(tokens: string[], flag: string): string | null {
  const index = tokens.indexOf(flag);
  if (index === -1) return null;
  const value = tokens[index + 1];
  if (!value) return null;
  if (value === "$") {
    return tokens[index + 2] ?? null;
  }
  return value;
}

function formatRudderTarget(target: string | undefined): string | null {
  if (!target || target.startsWith("-")) return null;
  const normalized = target.replace(/^#/, "");
  return isShellControlToken(normalized) ? null : normalized;
}

function summarizeIssueComment(command: string): string | null {
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

function describeRudderCommandSemanticInfo(command: string): TranscriptToolSemanticInfo | null {
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

function describeCommandSemanticInfo(command: string): TranscriptToolSemanticInfo {
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

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolPayload(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return formatUnknown(value);
}

function extractToolUseId(input: unknown): string | undefined {
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

function describeToolInvocation(name: string, input: unknown): { category: TranscriptToolCategory; label: string } {
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

function summarizeRecord(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(compactWhitespace(value), 120);
    }
  }
  return null;
}

function summarizeToolInput(name: string, input: unknown, density: TranscriptDensity): string {
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

function parseStructuredToolResult(result: string | undefined) {
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

function formatCommandTerminalOutput(result: string | undefined): string | null {
  if (!result) return null;
  const structured = parseStructuredToolResult(result);
  if (structured) {
    return structured.body || null;
  }
  return result;
}

function isCommandTool(name: string, input: unknown): boolean {
  if (name === "command_execution" || name === "shell" || name === "shellToolCall" || name === "bash") {
    return true;
  }
  if (typeof input === "string") {
    return /\b(?:bash|zsh|sh|cmd|powershell)\b/i.test(input);
  }
  const record = asRecord(input);
  return Boolean(record && (typeof record.command === "string" || typeof record.cmd === "string"));
}

function describeToolSemanticInfo(name: string, input: unknown): TranscriptToolSemanticInfo {
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
  const record = asRecord(input);
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

function formatSemanticDigest(
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

function summarizeToolResult(result: string | undefined, isError: boolean | undefined, density: TranscriptDensity): string {
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

function parseSystemActivity(text: string): { activityId?: string; name: string; status: "running" | "completed" } | null {
  const match = text.match(/^item (started|completed):\s*([a-z0-9_-]+)(?:\s+\(id=([^)]+)\))?$/i);
  if (!match) return null;
  return {
    status: match[1].toLowerCase() === "started" ? "running" : "completed",
    name: humanizeLabel(match[2] ?? "Activity"),
    activityId: match[3] || undefined,
  };
}

function getTodoListCompletedCount(items: TranscriptTodoListItem[]): number {
  return items.filter((item) => item.status === "completed").length;
}

function formatTodoListSummary(items: TranscriptTodoListItem[]): string {
  const completed = getTodoListCompletedCount(items);
  return `Todo list updated: ${completed}/${items.length} complete`;
}

function formatTodoListRaw(items: TranscriptTodoListItem[]): string {
  return items
    .map((item) => `${item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]"} ${item.text}`)
    .join("\n");
}

function shouldHideNiceModeStderr(text: string): boolean {
  const normalized = compactWhitespace(text).toLowerCase();
  return normalized.startsWith("[rudder] skipping saved session resume");
}

function groupCommandBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
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

function segmentTranscriptEntriesByTurn(entries: TranscriptEntry[]): {
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
        tone: "warn",
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

function summarizeChatTurn(blocks: TranscriptBlock[]): string | null {
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

function normalizeChatTranscriptTurns(
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

function TranscriptMessageBlock({
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

function TranscriptThinkingBlock({
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

function renderTranscriptBlock({
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

function CommandTerminalDetail({
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
  return (
    <div
      data-testid="command-terminal-detail"
      className={cn(
        "overflow-hidden rounded-xl border border-neutral-800 bg-[#0a0a0a] text-neutral-100 shadow-[0_18px_45px_-28px_rgb(0_0_0/0.75)]",
        className,
      )}
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-white/10 bg-[#171717] px-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
      </div>
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

function TranscriptToolCard({
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

function hasSelectedText() {
  if (typeof window === "undefined") return false;
  return (window.getSelection()?.toString().length ?? 0) > 0;
}

function DisclosureChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      data-state={open ? "open" : "closed"}
      className={cn("motion-disclosure-icon", className)}
      aria-hidden
    />
  );
}

function areAllToolEntriesErrored(entries: TranscriptToolCardEntry[]) {
  return entries.length > 0 && entries.every((entry) => entry.status === "error");
}

function formatTranscriptLabel(label: string) {
  return label
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function TranscriptCommandGroup({
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

function TranscriptActivityRow({
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

function TranscriptTodoListRow({
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

function TranscriptMemoryUpdateRow({
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

function TranscriptEventRow({
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
  const preview = truncate(compactWhitespace(block.text), compact ? 96 : 140);
  const toneClasses =
    block.tone === "error"
      ? "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-red-700 dark:text-red-300"
      : block.tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : block.tone === "info"
          ? "text-sky-700 dark:text-sky-300"
          : "text-foreground/75";

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

function TranscriptStdoutRow({
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

function flattenChatTranscriptActions(blocks: TranscriptBlock[]): ChatTranscriptAction[] {
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

function shouldHideChatToolResult(semantic: TranscriptToolSemanticInfo): boolean {
  return semantic.category === "read" || semantic.category === "skill";
}

function TranscriptChatStdoutActionRow({
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

  if (inline) {
    return (
      <div className="py-1.5" title={getTranscriptTimestampTitle(block.ts)}>
        <div className="flex w-full items-start gap-2 text-left">
          <TranscriptActionIconSlot category="stdout" status="completed" />
          <pre className={cn(
            "min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-foreground/80",
            density === "compact" ? "text-[11px] leading-5" : "text-xs leading-6",
          )}>
            {block.text}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="py-1.5" title={getTranscriptTimestampTitle(block.ts)}>
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse output details" : "Expand output details"}
      >
        <TranscriptActionIconSlot category="stdout" status="completed" />
        <span className={cn("min-w-0 flex-1 break-words text-foreground/82", density === "compact" ? "text-xs leading-5" : "text-sm leading-6")}>
          {preview}
        </span>
        <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground">
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

function TranscriptChatToolActionRow({
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

  return (
    <div
      className={cn("py-1.5", highlightError && block.status === "error" && "rounded-lg bg-red-500/[0.04] px-2")}
      title={getTranscriptTimestampTitle(block.ts)}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
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
        <TranscriptActionIconSlot category={semantic.category} status={iconStatus} />
        <span className={cn("min-w-0 flex-1 break-words text-foreground/84", density === "compact" ? "text-xs leading-5" : "text-sm leading-6")}>
          {semantic.summary}
        </span>
        {duration ? (
          <span className="pt-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {duration}
          </span>
        ) : null}
        {statusText ? (
          <span className={cn("pt-0.5 text-[10px] font-medium", rowTone)}>
            {statusText}
          </span>
        ) : null}
        {canExpand && !inline ? (
          <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground">
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

function TranscriptChatActionRow({
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

type ChatTranscriptTurnSegment =
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

function isChatActionBlock(block: TranscriptBlock): boolean {
  return block.type === "tool" || block.type === "command_group" || block.type === "stdout";
}

function segmentChatTranscriptBlocks(blocks: TranscriptBlock[]): ChatTranscriptTurnSegment[] {
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

function formatChatActionSummary(actions: ChatTranscriptAction[]): string {
  const infos = actions
    .filter((action): action is Extract<ChatTranscriptAction, { type: "tool" }> => action.type === "tool")
    .map((action) => describeToolSemanticInfo(action.entry.name, action.entry.input));
  const stdoutCount = actions.filter((action) => action.type === "stdout").length;
  return formatSemanticDigest(infos, stdoutCount, { preferDirectSummary: true });
}

function getChatActionIconInfo(action: ChatTranscriptAction): {
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

function TranscriptChatActionGroup({
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

function TranscriptChatTurn({
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
    <div className="space-y-3" title={getTranscriptTimestampTitle(turn.ts)}>
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

function trimTrailingWhitespace(value: string) {
  return value.replace(/\s+$/g, "");
}

function redactAssistantSuffixFromChatTranscript(
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

function filterChatAssistantTranscriptEntries(
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

function TranscriptChatTimeline({
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

interface DetailTimelineRow {
  key: string;
  block: Exclude<TranscriptBlock, { type: "command_group" }>;
}

function expandDetailTimelineBlocks(blocks: TranscriptBlock[]): DetailTimelineRow[] {
  const rows: DetailTimelineRow[] = [];

  for (const block of blocks) {
    if (block.type === "command_group") {
      block.items.forEach((item, index) => {
        rows.push({
          key: `${block.ts}-command-${index}-${item.ts}`,
          block: {
            type: "tool",
            ts: item.ts,
            endTs: item.endTs,
            name: item.name,
            input: item.input,
            result: item.result,
            isError: item.isError,
            status: item.status,
          },
        });
      });
      continue;
    }

    if (block.type === "message") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "thinking") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "tool") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "todo_list") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "activity") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "memory_update") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "event") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    rows.push({
      key: `${block.type}-${block.ts}-${rows.length}`,
      block,
    });
  }

  return rows;
}

function TranscriptDetailTimeline({
  entries,
  density,
  streaming,
  thinkingClassName,
  showDeveloperDiagnostics,
  onMarkdownLinkClick,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
  streaming: boolean;
  thinkingClassName?: string;
  showDeveloperDiagnostics: boolean;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
}) {
  const { preludeBlocks, turns } = useMemo(
    () => normalizeChatTranscriptTurns(entries, streaming, { showDeveloperDiagnostics }),
    [entries, streaming, showDeveloperDiagnostics],
  );
  const rows = expandDetailTimelineBlocks(preludeBlocks);

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        return (
          <Fragment key={row.key}>
            {row.block.type === "message" && (
              <TranscriptMessageBlock
                block={row.block}
                density={density}
                presentation="detail"
                className="text-sm leading-7"
                collapsibleSummary={row.block.role === "user"}
                onMarkdownLinkClick={onMarkdownLinkClick}
              />
            )}
            {row.block.type === "thinking" && (
              <TranscriptThinkingBlock
                block={row.block}
                density={density}
                className={thinkingClassName}
                collapsibleSummary
                onMarkdownLinkClick={onMarkdownLinkClick}
              />
            )}
            {row.block.type === "tool" && (
              <TranscriptToolCard block={row.block} density={density} presentation="detail" />
            )}
            {row.block.type === "todo_list" && (
              <TranscriptTodoListRow block={row.block} density={density} presentation="detail" />
            )}
            {row.block.type === "activity" && <TranscriptActivityRow block={row.block} density={density} />}
            {row.block.type === "event" && (
              <TranscriptEventRow block={row.block} density={density} presentation="detail" />
            )}
            {row.block.type === "stdout" && (
              <TranscriptStdoutRow
                block={row.block}
                density={density}
                collapseByDefault
                presentation="detail"
              />
            )}
          </Fragment>
        );
      })}
      {turns.map((turn, index) => {
        return (
          <div
            key={turn.key}
            className={cn(index === turns.length - 1 && streaming && "animate-in fade-in slide-in-from-bottom-1 duration-300")}
          >
            <TranscriptChatTurn
              turn={turn}
              density={density}
              thinkingClassName={thinkingClassName}
              variant="detail"
              onMarkdownLinkClick={onMarkdownLinkClick}
            />
          </div>
        );
      })}
    </div>
  );
}

function RawTranscriptView({
  entries,
  density,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
}) {
  const compact = density === "compact";
  return (
    <div className={cn("font-mono", compact ? "space-y-1 text-[11px]" : "space-y-1.5 text-xs")}>
      {entries.map((entry, idx) => (
        <div
          key={`${entry.kind}-${entry.ts}-${idx}`}
          className={cn(
            "grid gap-x-3",
            "grid-cols-[auto_1fr]",
          )}
        >
          <span className="text-[10px] tracking-[0.06em] text-muted-foreground">
            {formatTranscriptLabel(entry.kind)}
          </span>
          <pre className="min-w-0 whitespace-pre-wrap break-words text-foreground/80">
            {entry.kind === "tool_call"
              ? `${entry.name}\n${formatToolPayload(entry.input)}`
              : entry.kind === "tool_result"
                ? formatToolPayload(entry.content)
                : entry.kind === "todo_list"
                  ? formatTodoListRaw(entry.items)
                : entry.kind === "result"
                  ? `${entry.text}\n${formatTokens(entry.inputTokens)} / ${formatTokens(entry.outputTokens)} / $${entry.costUsd.toFixed(6)}`
                  : entry.kind === "init"
                    ? `model=${entry.model}${entry.sessionId ? ` session=${entry.sessionId}` : ""}`
                    : entry.text}
          </pre>
        </div>
      ))}
    </div>
  );
}

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

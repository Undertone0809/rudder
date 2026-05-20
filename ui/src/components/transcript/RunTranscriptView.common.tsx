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

export type TranscriptToolCategory =
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

export type TranscriptDigestBucket =
  | "explore"
  | "search"
  | "edit"
  | "run"
  | "tool";

export type TranscriptActionIconCategory = TranscriptToolCategory | "stdout" | "memory";
export type TranscriptActionIconStatus = "running" | "completed" | "error" | "neutral";

export interface TranscriptActionIconTreatment {
  key: string;
  label: string;
  Icon: LucideIcon;
}

export interface TranscriptToolSemanticInfo {
  category: TranscriptToolCategory;
  label: string;
  summary: string;
  bucket: TranscriptDigestBucket;
  quantity: number;
  noun: "file" | "location" | "item" | "tool" | "command" | "skill";
}

export interface TranscriptToolCardEntry {
  ts: string;
  endTs?: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: "running" | "completed" | "error";
}

export type TranscriptMemoryScope = "stable_instructions" | "daily_note" | "knowledge_graph";

export interface TranscriptMemoryUpdateChange {
  operation: string;
  path: string;
  scope: TranscriptMemoryScope;
}

export type TranscriptTodoListItem = Extract<TranscriptEntry, { kind: "todo_list" }>["items"][number];

export interface RunTranscriptViewProps {
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

export type TranscriptBlock =
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

export interface ChatTranscriptTurn {
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

export type ChatTranscriptAction =
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

export const COMMON_FILENAME_TOKENS = new Set([
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
export const STRONG_WRITE_COMMAND_TOKENS = new Set(["apply_patch", "patch", "ed", "tee", "mv", "cp", "rm", "mkdir", "touch"]);
export const LONG_EVENT_COLLAPSE_CHARS = 900;
export const LONG_EVENT_COLLAPSE_LINES = 8;
export const LOCAL_POSIX_FILE_ROOTS = [
  "/Users/",
  "/home/",
  "/Volumes/",
  "/tmp/",
  "/var/",
  "/opt/",
  "/mnt/",
  "/private/",
];

export type TranscriptMarkdownLinkClickHandler = MarkdownLinkClickHandler;

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function decodeFileUrlPath(href: string): string | null {
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

export function shouldHandlePlainClick(event: Parameters<MarkdownLinkClickHandler>[0]["event"]) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isTurnStartedText(value: string): boolean {
  return compactWhitespace(value).toLowerCase() === "turn started";
}

export function isRudderDeveloperDiagnosticLine(trimmed: string): boolean {
  if (/^\[rudder\](?:\s|$)/.test(trimmed)) return true;
  return false;
}

export function isRudderDeveloperDiagnosticContinuationLine(trimmed: string): boolean {
  return /^[\s./~,-]/.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed);
}

export function filterRoutineStdout(value: string, showDeveloperDiagnostics: boolean): string {
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

export function isWarningStderrLine(line: string): boolean {
  const trimmed = line.trim();
  return /^WARN\b/i.test(trimmed) || /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+/i.test(trimmed);
}

export function isAnalyticsForbiddenHtmlStart(line: string): boolean {
  return /WARN\s+codex_analytics::analytics_client:\s+events failed with status 403 Forbidden:\s+<html>/i.test(line.trim());
}

export function filterRenderableTranscriptEntries(
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

export function shouldCollapseEventText(text: string): boolean {
  return text.length > LONG_EVENT_COLLAPSE_CHARS || text.split(/\r?\n/).length > LONG_EVENT_COLLAPSE_LINES;
}

export function formatTranscriptTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function getTranscriptActionIconTreatment(category: TranscriptActionIconCategory): TranscriptActionIconTreatment {
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

export function getTranscriptActionIconTone(status: TranscriptActionIconStatus, category: TranscriptActionIconCategory): string {
  if (status === "error") return "text-red-600 dark:text-red-300";
  if (status === "running") return "text-cyan-600 dark:text-cyan-300";
  if (category === "skill") return "text-[#2f80ed]";
  return "text-muted-foreground";
}

export function TranscriptActionIcon({
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

export function TranscriptActionIconSlot({
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

export function TranscriptActionIconStack({
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

export function getTranscriptTimestampTitle(ts: string): string | undefined {
  return formatTranscriptTimestamp(ts) || undefined;
}

export function formatTranscriptDuration(startTs: string, endTs?: string): string | null {
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

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  if (word.endsWith("ch") || word.endsWith("sh")) return `${word}es`;
  if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

export function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}


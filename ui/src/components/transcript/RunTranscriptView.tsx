import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TranscriptEntry } from "../../agent-runtimes";
import { MarkdownBody } from "../MarkdownBody";
import { cn, formatTokens } from "../../lib/utils";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Loader2,
  TerminalSquare,
  User,
  Wrench,
} from "lucide-react";

export type TranscriptMode = "nice" | "raw";
export type TranscriptDensity = "comfortable" | "compact";
export type TranscriptPresentation = "default" | "chat" | "detail";

type TranscriptToolCategory =
  | "tool"
  | "bash"
  | "script"
  | "read"
  | "edit"
  | "grep"
  | "search"
  | "list"
  | "inspect";

type TranscriptDigestBucket =
  | "explore"
  | "search"
  | "edit"
  | "run"
  | "tool";

interface TranscriptToolSemanticInfo {
  category: TranscriptToolCategory;
  label: string;
  summary: string;
  bucket: TranscriptDigestBucket;
  quantity: number;
  noun: "file" | "location" | "item" | "tool" | "command";
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
      type: "event";
      ts: string;
      label: string;
      tone: "info" | "warn" | "error" | "neutral";
      text: string;
      detail?: string;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isTurnStartedText(value: string): boolean {
  return compactWhitespace(value).toLowerCase() === "turn started";
}

function filterRoutineStdout(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^\[rudder\] Using Rudder-managed .+ home ".+"(?: \(seeded from ".+"\))?\.$/.test(line.trim()))
    .join("\n")
    .trim();
}

function formatTranscriptTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
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

function stripWrappedShell(command: string): string {
  const trimmed = compactWhitespace(command);
  const shellWrapped = trimmed.match(/^(?:(?:\/bin\/)?(?:zsh|bash|sh)|cmd(?:\.exe)?(?:\s+\/d)?(?:\s+\/s)?(?:\s+\/c)?)\s+(?:-lc|\/c)\s+(.+)$/i);
  const inner = shellWrapped?.[1] ?? trimmed;
  const quoted = inner.match(/^(['"])([\s\S]*)\1$/);
  return compactWhitespace(quoted?.[2] ?? inner);
}

function firstCommandToken(command: string): string {
  return stripWrappedShell(command).split(/\s+/)[0]?.toLowerCase() ?? "";
}

function classifyShellCommand(command: string): { category: TranscriptToolCategory; label: string } {
  const normalized = stripWrappedShell(command);
  const firstToken = firstCommandToken(command);
  const normalizedLower = normalized.toLowerCase();

  if (!firstToken) {
    return { category: "bash", label: "Command" };
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
  if (
    firstToken === "apply_patch" ||
    firstToken === "patch" ||
    firstToken === "ed" ||
    firstToken === "tee" ||
    firstToken === "mv" ||
    firstToken === "cp" ||
    firstToken === "rm" ||
    firstToken === "mkdir" ||
    firstToken === "touch" ||
    firstToken === "printf" ||
    firstToken === "perl" ||
    /\b-sed\b/.test(normalizedLower) ||
    /\bsed\s+-i\b/.test(normalizedLower) ||
    /\bperl\b.*-0?pi\b/.test(normalizedLower) ||
    /\btee\b/.test(normalizedLower) ||
    /\s>\s|\s>>\s/.test(normalized)
  ) {
    return { category: "edit", label: "Edit" };
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
  return quoted ? quoted[2] : trimmed;
}

function cleanShellToken(token: string): string {
  return unwrapQuotedToken(token).replace(/[;,|&]+$/g, "").trim();
}

function tokenizeShell(command: string): string[] {
  const tokens = stripWrappedShell(command).match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|[^\s]+/g) ?? [];
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

function isLikelyPathToken(token: string): boolean {
  const value = normalizePathTarget(token);
  if (!value || value.startsWith("-")) return false;
  if (/[{}[\]$]/.test(value)) return false;
  if (value.includes("/") || value.startsWith(".") || value.startsWith("~")) return true;
  if (COMMON_FILENAME_TOKENS.has(value)) return true;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/.test(value)) return true;
  return false;
}

function getShellPositionalArgs(command: string): string[] {
  const tokens = tokenizeShell(command);
  const positional: string[] = [];

  for (const token of tokens.slice(1)) {
    if (/^(?:&&|\|\||[|;])$/.test(token)) break;
    if (token === "--") continue;
    if (token.startsWith("-")) continue;
    positional.push(token);
  }

  return positional;
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

function describeCommandSemanticInfo(command: string): TranscriptToolSemanticInfo {
  const invocation = classifyShellCommand(command);
  const normalized = stripWrappedShell(command);
  const positionalArgs = getShellPositionalArgs(command);
  const pathTargets = dedupeTargets(positionalArgs.filter(isLikelyPathToken));

  if (invocation.category === "read") {
    const fallbackTarget = positionalArgs[positionalArgs.length - 1];
    const targets = pathTargets.length > 0
      ? pathTargets
      : fallbackTarget
        ? dedupeTargets([fallbackTarget])
        : [];
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
    const redirectTarget = normalized.match(/(?:^|\s)(?:>>?|tee)\s+([^\s]+)/);
    const fallbackTarget = redirectTarget?.[1] ?? positionalArgs[positionalArgs.length - 1];
    const targets = pathTargets.length > 0
      ? pathTargets
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
    summary: `Ran ${truncate(summarizeCommandPhrase(command), 64)}`,
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

function formatCommandResult(result: string | undefined, status: TranscriptToolCardEntry["status"]): string | null {
  if (!result) return status === "running" ? "Waiting for result..." : null;
  const structured = parseStructuredToolResult(result);
  if (structured) {
    if (structured.body) return structured.body;
    if (structured.status === "completed") return "Completed";
    if (structured.status === "failed" || structured.status === "error") {
      return structured.exitCode ? `Failed with exit code ${structured.exitCode}` : "Failed";
    }
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

function displayToolName(name: string, input: unknown): string {
  return describeToolInvocation(name, input).label;
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

  const invocation = describeToolInvocation(name, input);
  const record = asRecord(input);
  const paths = extractRecordPaths(record);
  const query = extractRecordQuery(record);

  if (invocation.category === "read") {
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
    parts.push(`Explored ${exploreCount} ${pluralize(noun, exploreCount)}`);
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

export function normalizeTranscript(entries: TranscriptEntry[], streaming: boolean): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const pendingToolBlocks = new Map<string, Extract<TranscriptBlock, { type: "tool" }>>();
  const pendingActivityBlocks = new Map<string, Extract<TranscriptBlock, { type: "activity" }>>();

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
        name: displayToolName(entry.name, entry.input),
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
        name: humanizeLabel(entry.toolName ?? "tool"),
        toolUseId: entry.toolUseId,
        input: null,
        result: entry.content,
        isError: entry.isError,
        status: entry.isError ? "error" : "completed",
        });
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
      });
      continue;
    }

    if (entry.kind === "system") {
      if (compactWhitespace(entry.text).toLowerCase() === "turn started") {
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

    const filteredStdout = filterRoutineStdout(entry.text);
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

function normalizeChatTranscriptTurns(entries: TranscriptEntry[], streaming: boolean): {
  preludeBlocks: TranscriptBlock[];
  turns: ChatTranscriptTurn[];
} {
  const { preludeEntries, turnEntries } = segmentTranscriptEntriesByTurn(entries);
  const preludeBlocks = normalizeTranscript(preludeEntries, streaming);
  const turns = turnEntries
    .map((turn, index) => {
      const blocks = normalizeTranscript(turn, streaming);
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
}: {
  block: Extract<TranscriptBlock, { type: "message" }>;
  density: TranscriptDensity;
  presentation?: TranscriptPresentation;
  className?: string;
  collapsibleSummary?: boolean;
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
    >
      {block.text}
    </MarkdownBody>
  );

  if (!isUser || !collapsibleSummary) {
    return (
      <div>
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
    <div className="rounded-lg border border-border/30 bg-muted/10">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse user message" : "Expand user message"}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
          <User className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          <span>User</span>
        </div>
      </button>
      {open && <div className="border-t border-border/20 px-2.5 pb-2.5 pt-2">{body}</div>}
    </div>
  );
}

function TranscriptThinkingBlock({
  block,
  density,
  className,
  collapsibleSummary = false,
}: {
  block: Extract<TranscriptBlock, { type: "thinking" }>;
  density: TranscriptDensity;
  className?: string;
  collapsibleSummary?: boolean;
}) {
  const [open, setOpen] = useState(() => Boolean(block.streaming));
  const wasStreamingRef = useRef(block.streaming);

  useEffect(() => {
    if (block.streaming) {
      setOpen(true);
    }
  }, [block.streaming]);

  useEffect(() => {
    if (collapsibleSummary && wasStreamingRef.current && !block.streaming) {
      setOpen(false);
    }
    wasStreamingRef.current = block.streaming;
  }, [block.streaming, collapsibleSummary]);

  const previewSource = compactWhitespace(block.text);
  const preview = truncate(previewSource, density === "compact" ? 100 : 160);

  const body = (
    <MarkdownBody
      className={cn(
        "italic text-foreground/75 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        density === "compact" ? "text-[11px] leading-5" : "text-sm leading-6",
        className,
      )}
    >
      {block.text}
    </MarkdownBody>
  );

  if (!collapsibleSummary) {
    return body;
  }

  return (
    <div className="rounded-lg border border-border/30 bg-muted/10">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse thinking" : "Expand thinking"}
      >
        {block.streaming ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground">Thinking</div>
          {!open && !block.streaming ? (
            <div className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-foreground/55">{preview || "…"}</div>
          ) : null}
        </div>
      </button>
      {(open || block.streaming) && (
        <div className="border-t border-border/20 px-2.5 pb-2.5 pt-2">{body}</div>
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
}: {
  block: TranscriptBlock;
  index: number;
  density: TranscriptDensity;
  presentation: TranscriptPresentation;
  collapseStdout: boolean;
  thinkingClassName?: string;
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
        />
      )}
      {block.type === "thinking" && (
        <TranscriptThinkingBlock
          block={block}
          density={density}
          className={thinkingClassName}
          collapsibleSummary={presentation === "chat"}
        />
      )}
      {block.type === "tool" && <TranscriptToolCard block={block} density={density} presentation={presentation} />}
      {block.type === "command_group" && <TranscriptCommandGroup block={block} density={density} />}
      {block.type === "stdout" && (
        <TranscriptStdoutRow
          block={block}
          density={density}
          collapseByDefault={collapseStdout}
          presentation={presentation}
        />
      )}
      {block.type === "activity" && <TranscriptActivityRow block={block} density={density} />}
      {block.type === "event" && (
        <TranscriptEventRow block={block} density={density} presentation={presentation} />
      )}
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
    ? formatCommandResult(block.result, block.status)
    : block.result
      ? formatToolPayload(block.result)
      : "Waiting for result...";
  const detailsClass = cn(
    "space-y-3",
    block.status === "error" && "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3",
    detail && "rounded-xl border border-border/40 bg-background/60 p-3",
  );
  const iconClass = cn(
    "mt-0.5 h-3.5 w-3.5 shrink-0",
    block.status === "error"
      ? "text-red-600 dark:text-red-300"
      : block.status === "completed"
        ? "text-emerald-600 dark:text-emerald-300"
        : "text-cyan-600 dark:text-cyan-300",
  );
  const summary = semantic.summary;
  const outerClass = cn(
    detail && "rounded-xl border border-border/60 bg-background/80 p-3 shadow-sm",
    block.status === "error" && "rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3",
  );

  return (
    <div className={outerClass}>
      <div className="flex items-start gap-2">
        {block.status === "error" ? (
          <CircleAlert className={iconClass} />
        ) : block.status === "completed" ? (
          isCommand ? <TerminalSquare className={iconClass} /> : <Check className={iconClass} />
        ) : (
          isCommand ? <TerminalSquare className={iconClass} /> : <Wrench className={iconClass} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
              {semantic.label}
            </span>
            <span className={cn("text-[10px] font-semibold tracking-[0.05em]", statusTone)}>
              {statusLabel}
            </span>
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
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
      {open && (
        <div className="mt-3">
          <div className={detailsClass}>
            <div className={cn("grid gap-3", compact ? "grid-cols-1" : "lg:grid-cols-2")}>
              <div>
                <div className="mb-1 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
                  {command ? "Command" : "Request"}
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
        </div>
      )}
    </div>
  );
}

function hasSelectedText() {
  if (typeof window === "undefined") return false;
  return (window.getSelection()?.toString().length ?? 0) > 0;
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
  const [open, setOpen] = useState(block.items.some((item) => item.status === "error"));
  const compact = density === "compact";
  const runningItem = [...block.items].reverse().find((item) => item.status === "running");
  const hasError = block.items.some((item) => item.status === "error");
  const isRunning = Boolean(runningItem);
  const showExpandedErrorState = open && hasError;
  const semanticItems = block.items.map((item) => describeToolSemanticInfo(item.name, item.input));
  const summary = formatSemanticDigest(semanticItems, 0, { preferDirectSummary: true });

  return (
    <div className={cn(showExpandedErrorState && "rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3")}>
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
        <div className="mt-0.5 flex shrink-0 items-center">
          {block.items.slice(0, Math.min(block.items.length, 3)).map((_, index) => (
            <span
              key={index}
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-full border shadow-sm",
                index > 0 && "-ml-1.5",
                isRunning
                  ? "border-cyan-500/25 bg-cyan-500/[0.08] text-cyan-600 dark:text-cyan-300"
                  : "border-border/70 bg-background text-foreground/55",
                isRunning && "animate-pulse",
              )}
            >
              <TerminalSquare className="h-3.5 w-3.5" />
            </span>
          ))}
        </div>
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
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
      {open && (
        <div className={cn("mt-3 space-y-3", hasError && "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3")}>
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
    <div className="flex items-start gap-2">
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

function TranscriptEventRow({
  block,
  density,
  presentation = "default",
}: {
  block: Extract<TranscriptBlock, { type: "event" }>;
  density: TranscriptDensity;
  presentation?: TranscriptPresentation;
}) {
  const compact = density === "compact";
  const detail = presentation === "detail";
  const toneClasses =
    block.tone === "error"
      ? "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-red-700 dark:text-red-300"
      : block.tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : block.tone === "info"
          ? "text-sky-700 dark:text-sky-300"
          : "text-foreground/75";

  return (
    <div className={toneClasses}>
      <div className="flex items-start gap-2">
        {block.tone === "error" ? (
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : block.tone === "warn" ? (
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-current/50" />
        )}
        <div className="min-w-0 flex-1">
          {block.label === "result" && block.tone !== "error" ? (
            <div className={cn("whitespace-pre-wrap break-words text-sky-700 dark:text-sky-300", compact ? "text-[11px]" : "text-xs")}>
              {block.text}
            </div>
          ) : detail ? (
            <div className={cn("whitespace-pre-wrap break-words", compact ? "text-[11px]" : "text-xs")}>
              {block.text}
            </div>
          ) : (
            <div className={cn("whitespace-pre-wrap break-words", compact ? "text-[11px]" : "text-xs")}>
              <span className="text-[10px] font-semibold tracking-[0.05em] text-muted-foreground/70">
                {formatTranscriptLabel(block.label)}
              </span>
              {block.text ? <span className="ml-2">{block.text}</span> : null}
            </div>
          )}
          {block.detail && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/75">
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
    <div>
      {detail ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse stdout details" : "Expand stdout details"}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
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
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </div>
      )}
      {open && (
        <pre className={cn(
          detail ? "overflow-x-auto whitespace-pre-wrap break-words font-mono text-foreground/80" : "mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-foreground/80",
          density === "compact" ? "text-[11px]" : "text-xs",
        )}>
          {block.text}
        </pre>
      )}
    </div>
  );
}

function formatChatToolSummary(turn: ChatTranscriptTurn): string {
  const infos: TranscriptToolSemanticInfo[] = [];
  for (const block of turn.blocks) {
    if (block.type === "command_group") {
      infos.push(...block.items.map((item) => describeToolSemanticInfo(item.name, item.input)));
      continue;
    }
    if (block.type === "tool") {
      infos.push(describeToolSemanticInfo(block.name, block.input));
    }
  }
  return formatSemanticDigest(infos, turn.stdoutCount, { preferDirectSummary: true });
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
  return semantic.category === "read";
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
      <div className="py-1.5">
        <div className="flex w-full items-start gap-2 text-left">
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
    <div className="py-1.5">
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse output details" : "Expand output details"}
      >
        <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("min-w-0 flex-1 break-words text-foreground/82", density === "compact" ? "text-xs leading-5" : "text-sm leading-6")}>
          {preview}
        </span>
        <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>
      {open ? (
        <pre className={cn(
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
}: {
  block: TranscriptToolCardEntry;
  density: TranscriptDensity;
  inline?: boolean;
}) {
  const semantic = describeToolSemanticInfo(block.name, block.input);
  const isCommand = isCommandTool(block.name, block.input);
  const command = getToolCommand(block);
  const requestText = command ?? (formatToolPayload(block.input) || "<empty>");
  const responseText = shouldHideChatToolResult(semantic)
    ? null
    : command
      ? formatCommandResult(block.result, block.status)
      : block.result
        ? formatToolPayload(block.result)
        : block.status === "running"
          ? "Waiting for result..."
          : null;
  const canExpand = Boolean(command || responseText || (!isCommand && requestText !== "<empty>"));
  const [open, setOpen] = useState(inline || block.status === "error");
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

  return (
    <div className={cn("py-1.5", block.status === "error" && "rounded-lg bg-red-500/[0.04] px-2")}>
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
        {block.status === "error" ? (
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-300" />
        ) : block.status === "running" ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-cyan-600 dark:text-cyan-300" />
        ) : isCommand ? (
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
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
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>
        ) : null}
      </button>
      {canExpand && open ? (
        <div className="ml-5 mt-2 space-y-2 rounded-lg border border-border/35 bg-muted/10 p-2.5">
          <div>
            <div className="mb-1 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
              {command ? "Command" : "Input"}
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
              {requestText}
            </pre>
          </div>
          {responseText ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
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
      ) : null}
    </div>
  );
}

function TranscriptChatActionRow({
  action,
  density,
  inline = false,
}: {
  action: ChatTranscriptAction;
  density: TranscriptDensity;
  inline?: boolean;
}) {
  if (action.type === "stdout") {
    return <TranscriptChatStdoutActionRow block={action.entry} density={density} inline={inline} />;
  }

  return <TranscriptChatToolActionRow block={action.entry} density={density} inline={inline} />;
}

function TranscriptChatTurn({
  turn,
  density,
  thinkingClassName,
}: {
  turn: ChatTranscriptTurn;
  density: TranscriptDensity;
  thinkingClassName?: string;
}) {
  const compact = density === "compact";
  const primaryBlocks = turn.blocks.filter((block) => (
    block.type !== "tool" && block.type !== "command_group" && block.type !== "stdout"
  ));
  const actions = flattenChatTranscriptActions(turn.blocks);
  const toolSummary = formatChatToolSummary(turn);
  const hasSingleAction = actions.length === 1;
  const [detailsOpen, setDetailsOpen] = useState(() => turn.hasError);

  useEffect(() => {
    if (turn.hasError) {
      setDetailsOpen(true);
    }
  }, [turn.hasError]);

  return (
    <section
      className={cn(
        "rounded-[18px] border px-3.5 py-3",
        turn.hasError
          ? "border-red-500/20 bg-red-500/[0.04]"
          : turn.hasRunning
            ? "border-cyan-500/20 bg-cyan-500/[0.035]"
            : "border-border/50 bg-background/45",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em]",
              turn.hasError
                ? "border-red-500/20 bg-red-500/[0.08] text-red-700 dark:text-red-300"
                : turn.hasRunning
                  ? "border-cyan-500/20 bg-cyan-500/[0.08] text-cyan-700 dark:text-cyan-300"
                  : "border-border/60 bg-background/80 text-muted-foreground",
            )}>
              Model turn {turn.index}
            </span>
            {turn.hasRunning ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-cyan-700 dark:text-cyan-300">
                <Loader2 className="h-3 w-3 animate-spin" />
                Running
              </span>
            ) : turn.hasError ? (
              <span className="text-[11px] text-red-700 dark:text-red-300">Needs review</span>
            ) : (
              <span className="text-[11px] text-muted-foreground">Completed</span>
            )}
            <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
              {formatTranscriptTimestamp(turn.ts)}
            </span>
          </div>
          {turn.preview ? (
            <p className={cn(
              "mt-2 break-words text-foreground/78",
              compact ? "text-[12px] leading-5" : "text-[13px] leading-6",
            )}>
              {turn.preview}
            </p>
          ) : null}
        </div>
      </div>

      {primaryBlocks.length > 0 ? (
        <div className="mt-3 space-y-2.5 border-l border-border/35 pl-3">
          {primaryBlocks.map((block, index) => renderTranscriptBlock({
            block,
            index,
            density,
            presentation: "chat",
            collapseStdout: true,
            thinkingClassName,
          }))}
        </div>
      ) : null}

      {actions.length > 0 ? (
        <div className="mt-3 border-t border-border/35 pt-3">
          {hasSingleAction ? (
            <div className="divide-y divide-border/30 border-l border-border/35 pl-3">
              <TranscriptChatActionRow
                action={actions[0]}
                density={density}
                inline
              />
            </div>
          ) : (
            <>
              <button
                type="button"
                className={cn(
                  "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                  turn.hasError ? "hover:bg-red-500/[0.05]" : "hover:bg-muted/10",
                )}
                onClick={() => setDetailsOpen((value) => !value)}
                aria-expanded={detailsOpen}
                aria-label={detailsOpen ? `Collapse tool activity for model turn ${turn.index}` : `Expand tool activity for model turn ${turn.index}`}
              >
                <span className="flex shrink-0 items-center">
                  {actions.slice(0, Math.min(actions.length, 3)).map((_, index) => (
                    <span
                      key={index}
                      className={cn(
                        "inline-flex h-6 w-6 items-center justify-center rounded-full border",
                        index > 0 && "-ml-1.5",
                        turn.hasError
                          ? "border-red-500/20 bg-red-500/[0.08] text-red-700 dark:text-red-300"
                          : turn.hasRunning
                            ? "border-cyan-500/20 bg-cyan-500/[0.08] text-cyan-700 dark:text-cyan-300"
                            : "border-border/60 bg-background/80 text-muted-foreground",
                      )}
                    >
                      <TerminalSquare className="h-3.5 w-3.5" />
                    </span>
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn(
                    "block break-words text-foreground/82",
                    compact ? "text-xs" : "text-sm",
                  )}>
                    {toolSummary || "Tool details"}
                  </span>
                </span>
                <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground">
                  {detailsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
              </button>

              {detailsOpen ? (
                <div className="mt-2 divide-y divide-border/30 border-l border-border/35 pl-3">
                  {actions.map((action) => (
                    <TranscriptChatActionRow
                      key={action.key}
                      action={action}
                      density={density}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function TranscriptChatTimeline({
  entries,
  density,
  streaming,
  collapseStdout,
  thinkingClassName,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
  streaming: boolean;
  collapseStdout: boolean;
  thinkingClassName?: string;
}) {
  const { preludeBlocks, turns } = useMemo(
    () => normalizeChatTranscriptTurns(entries, streaming),
    [entries, streaming],
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
      }))}
      {turns.map((turn) => (
        <TranscriptChatTurn
          key={turn.key}
          turn={turn}
          density={density}
          thinkingClassName={thinkingClassName}
        />
      ))}
    </div>
  );
}

type DetailTimelineTone = "neutral" | "accent" | "success" | "warning" | "danger";

interface DetailTimelineRow {
  key: string;
  ts: string;
  label: string;
  tone: DetailTimelineTone;
  block:
    | Extract<TranscriptBlock, { type: "message" }>
    | Extract<TranscriptBlock, { type: "thinking" }>
    | Extract<TranscriptBlock, { type: "tool" }>
    | Extract<TranscriptBlock, { type: "activity" }>
    | Extract<TranscriptBlock, { type: "event" }>
    | Extract<TranscriptBlock, { type: "stdout" }>;
}

function detailToneClasses(tone: DetailTimelineTone): { dot: string; badge: string } {
  switch (tone) {
    case "accent":
      return {
        dot: "bg-cyan-500",
        badge: "border-cyan-500/20 bg-cyan-500/[0.08] text-cyan-700 dark:text-cyan-300",
      };
    case "success":
      return {
        dot: "bg-emerald-500",
        badge: "border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300",
      };
    case "warning":
      return {
        dot: "bg-amber-500",
        badge: "border-amber-500/20 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300",
      };
    case "danger":
      return {
        dot: "bg-red-500",
        badge: "border-red-500/20 bg-red-500/[0.08] text-red-700 dark:text-red-300",
      };
    case "neutral":
    default:
      return {
        dot: "bg-muted-foreground/60",
        badge: "border-border/60 bg-background/70 text-muted-foreground",
      };
  }
}

function TranscriptDetailRow({
  ts,
  label,
  tone,
  last,
  children,
}: {
  ts: string;
  label: string;
  tone: DetailTimelineTone;
  last?: boolean;
  children: ReactNode;
}) {
  const styles = detailToneClasses(tone);

  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-4">
      <div className="relative min-w-0 pt-1 pr-2">
        <div className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
          {formatTranscriptTimestamp(ts)}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", styles.dot)} />
          <span className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em]",
            styles.badge,
          )}>
            {label}
          </span>
        </div>
        {!last && <div className="absolute left-[0.35rem] top-7 bottom-[-1.25rem] w-px bg-border/60" />}
      </div>
      <div className="min-w-0">
        {children}
      </div>
    </div>
  );
}

function expandDetailTimelineBlocks(blocks: TranscriptBlock[]): DetailTimelineRow[] {
  const rows: DetailTimelineRow[] = [];

  for (const block of blocks) {
    if (block.type === "command_group") {
      block.items.forEach((item, index) => {
        rows.push({
          key: `${block.ts}-command-${index}-${item.ts}`,
          ts: item.ts,
          label: "command",
          tone:
            item.status === "error"
              ? "danger"
              : item.status === "running"
                ? "accent"
                : "success",
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
        ts: block.ts,
        label: block.role,
        tone: block.role === "assistant" ? "success" : "neutral",
        block,
      });
      continue;
    }

    if (block.type === "thinking") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        ts: block.ts,
        label: "thinking",
        tone: "warning",
        block,
      });
      continue;
    }

    if (block.type === "tool") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        ts: block.ts,
        label: "tool",
        tone:
          block.status === "error"
            ? "danger"
            : block.status === "running"
              ? "accent"
              : "success",
        block,
      });
      continue;
    }

    if (block.type === "activity") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        ts: block.ts,
        label: "activity",
        tone: block.status === "completed" ? "success" : "accent",
        block,
      });
      continue;
    }

    if (block.type === "event") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        ts: block.ts,
        label: block.label,
        tone:
          block.tone === "error"
            ? "danger"
            : block.tone === "warn"
              ? "warning"
              : block.tone === "info"
                ? "accent"
                : "neutral",
        block,
      });
      continue;
    }

    rows.push({
      key: `${block.type}-${block.ts}-${rows.length}`,
      ts: block.ts,
      label: "stdout",
      tone: "neutral",
      block,
    });
  }

  return rows;
}

function TranscriptDetailTimeline({
  blocks,
  density,
  streaming,
  thinkingClassName,
}: {
  blocks: TranscriptBlock[];
  density: TranscriptDensity;
  streaming: boolean;
  thinkingClassName?: string;
}) {
  const rows = expandDetailTimelineBlocks(blocks);

  return (
    <div className="space-y-4">
      {rows.map((row, index) => {
        const isLast = index === rows.length - 1;

        return (
          <TranscriptDetailRow
            key={row.key}
            ts={row.ts}
            label={row.label}
            tone={row.tone}
            last={isLast && !streaming}
          >
            {row.block.type === "message" && (
              <TranscriptMessageBlock
                block={row.block}
                density={density}
                presentation="detail"
                className="text-sm leading-7"
                collapsibleSummary={row.block.role === "user"}
              />
            )}
            {row.block.type === "thinking" && (
              <TranscriptThinkingBlock
                block={row.block}
                density={density}
                className={thinkingClassName}
                collapsibleSummary
              />
            )}
            {row.block.type === "tool" && (
              <TranscriptToolCard block={row.block} density={density} presentation="detail" />
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
          </TranscriptDetailRow>
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
}: RunTranscriptViewProps) {
  const blocks = useMemo(() => normalizeTranscript(entries, streaming), [entries, streaming]);
  const visibleBlocks = limit ? blocks.slice(-limit) : blocks;
  const visibleEntries = limit ? entries.slice(-limit) : entries;

  if (entries.length === 0) {
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
          blocks={visibleBlocks}
          density={density}
          streaming={streaming}
          thinkingClassName={thinkingClassName}
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
          })}
        </div>
      ))}
    </div>
  );
}

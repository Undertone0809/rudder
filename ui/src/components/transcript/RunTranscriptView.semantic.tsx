import { asRecord, COMMON_FILENAME_TOKENS, compactWhitespace, humanizeLabel, pluralize, resolveTranscriptFileTarget, TranscriptDensity, TranscriptFileTarget, TranscriptSkillTarget, TranscriptToolCategory, TranscriptToolSemanticInfo, truncate } from "./RunTranscriptView.common";
import { classifyShellCommand, cleanShellToken, commandSegmentFrom, commandSegmentUsesInPlaceSed, extractStdoutWriteRedirectTarget, findStrongEditSegment, getShellPositionalArgsFromTokens, hasHelpSignal, isShellControlToken, shellTokensForCommand, stripWrappedShell, tokenizeShell } from "./RunTranscriptView.shell";
import { parseUnifiedDiff } from "./TranscriptUnifiedDiff";

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

export function transcriptArtifactBasename(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? normalized;
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
  for (const key of ["path", "filePath", "file_path", "targetPath", "directory", "dir"]) {
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

export function extractRecordWorkingDirectory(record: Record<string, unknown> | null): string | null {
  return readStringField(record, ["workdir", "workingDirectory", "working_directory", "cwd"]);
}

export function createTranscriptFileTargets(
  paths: string[],
  record: Record<string, unknown> | null,
): TranscriptFileTarget[] {
  const workingDirectory = extractRecordWorkingDirectory(record);
  return dedupeTargets(paths).map((label) => ({
    displayLabel: transcriptArtifactBasename(label),
    label,
    path: resolveTranscriptFileTarget(label, workingDirectory),
  }));
}

export function createTranscriptSkillTargets(
  paths: string[],
  record: Record<string, unknown> | null,
): Array<TranscriptSkillTarget & TranscriptFileTarget> {
  const fileTargets = createTranscriptFileTargets(paths, record);
  return fileTargets.flatMap((target) => {
    const name = extractSkillSlugFromEntryPath(target.label);
    return name ? [{ ...target, displayLabel: name, name }] : [];
  });
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatFileChangeEvidenceWarning(input: unknown): string | null {
  const record = asRecord(input);
  const truncation = record?.truncation;
  if (typeof truncation === "string" && truncation.trim()) {
    return `File-change evidence was truncated: ${compactWhitespace(truncation)}`;
  }
  const detail = asRecord(truncation);
  if (!detail) return null;

  const message = readStringField(detail, ["message", "reason"]);
  const omittedFiles = readFiniteNumber(
    detail.omitted_file_count
    ?? detail.omitted_files
    ?? detail.files_omitted
    ?? detail.omittedFiles
    ?? detail.filesOmitted,
  );
  const omittedBytes = readFiniteNumber(
    detail.omitted_bytes
    ?? detail.bytes_omitted
    ?? detail.omittedBytes
    ?? detail.bytesOmitted,
  );
  const byteLimit = readFiniteNumber(
    detail.byte_limit
    ?? detail.max_bytes
    ?? detail.byteLimit
    ?? detail.maxBytes,
  );
  const truncatedDiffs = readFiniteNumber(
    detail.truncated_diff_count
    ?? detail.truncatedDiffCount,
  );
  const details: string[] = [];
  if (omittedFiles) details.push(`${omittedFiles} ${pluralize("file", omittedFiles)} omitted`);
  if (truncatedDiffs) details.push(`${truncatedDiffs} ${pluralize("diff", truncatedDiffs)} truncated`);
  if (omittedBytes) details.push(`${omittedBytes.toLocaleString()} bytes omitted`);
  if (byteLimit) details.push(`${byteLimit.toLocaleString()}-byte evidence limit`);
  if (message) details.push(message);
  return details.length > 0
    ? `File-change evidence was truncated: ${details.join("; ")}.`
    : "File-change evidence was truncated.";
}

function fileChangeOperation(kind: unknown): {
  movePath: string | null;
  operation: "add" | "delete" | "update" | "move" | "unknown";
} {
  if (typeof kind === "string") {
    const normalized = kind.trim().toLowerCase();
    if (normalized === "add" || normalized === "delete" || normalized === "update") {
      return { movePath: null, operation: normalized };
    }
    if (normalized === "move") return { movePath: null, operation: "move" };
    return { movePath: null, operation: "unknown" };
  }

  const record = asRecord(kind);
  const type = readStringField(record, ["type"])?.toLowerCase() ?? "unknown";
  const movePath = readStringField(record, ["move_path", "movePath"]);
  if (type === "update" && movePath) return { movePath, operation: "move" };
  if (type === "add" || type === "delete" || type === "update") {
    return { movePath, operation: type };
  }
  if (type === "move") return { movePath, operation: "move" };
  return { movePath, operation: "unknown" };
}

export function extractFileChangeEvidence(input: unknown): NonNullable<TranscriptToolSemanticInfo["fileChanges"]> {
  const record = asRecord(input);
  const changes = Array.isArray(record?.changes) ? record.changes : [];
  return changes.flatMap((value) => {
    const change = asRecord(value);
    const path = readStringField(change, ["path"]);
    if (!change || !path) return [];
    const diff = typeof change.diff === "string" ? change.diff : null;
    const parsed = diff ? parseUnifiedDiff(diff) : null;
    const { movePath, operation } = fileChangeOperation(change.kind);
    return [{
      additions: parsed?.additions ?? 0,
      deletions: parsed?.deletions ?? 0,
      diff,
      diffOriginalBytes: readFiniteNumber(change.diff_original_bytes ?? change.diffOriginalBytes),
      diffTruncated: change.diff_truncated === true || change.diffTruncated === true,
      displayLabel: transcriptArtifactBasename(path),
      movePath,
      operation,
      path,
    }];
  });
}

function fileChangeEvidenceCount(
  record: Record<string, unknown> | null,
  retainedCount: number,
): number {
  const truncation = asRecord(record?.truncation);
  const originalCount = readFiniteNumber(
    truncation?.original_file_count
    ?? truncation?.originalFileCount,
  );
  return originalCount !== null
    && Number.isInteger(originalCount)
    && originalCount >= retainedCount
    ? originalCount
    : retainedCount;
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

export function formatMcpLabel(_details: McpToolDetails): string {
  return "MCP";
}

const MCP_SUMMARY_TOKEN_LABELS: Record<string, string> = {
  api: "API",
  browser: "browser",
  dom: "DOM",
  exa: "Exa",
  github: "GitHub",
  id: "ID",
  mcp: "MCP",
  oauth: "OAuth",
  pr: "PR",
  rudder: "Rudder",
  url: "URL",
};

const MCP_RUDDER_SERVER_ALIASES = new Set([
  "rudder",
  "rudder_tools",
  "rudder_browser",
]);

// These are presentation aliases only. The MCP/runtime names remain the source of truth.
const MCP_SUMMARY_TOOL_RULES: Readonly<Record<string, string>> = {
  fetch_pr: "Get pull request",
  fetch_issue: "Get issue",
  search_code: "Search code",
  list_tables: "List tables",
  exa_search: "Search web",
  rudder_chat_transcript: "Read Rudder chat transcript",

  agent_me: "Get current agent",
  agent_inbox: "Get agent inbox",
  agent_capabilities: "Get agent capabilities",
  agent_update: "Update agent",
  agent_skills_create: "Create agent skill",
  agent_skills_enable: "Enable agent skills",
  agent_skills_sync: "Sync agent skills",
  goal_list: "List goals",
  goal_context: "Get goal context",
  goal_progress: "Record goal progress",
  goal_checkpoint: "Record goal checkpoint",
  goal_change_propose: "Propose goal change",
  goal_result_propose: "Propose goal result",
  issue_get: "Get issue",
  issue_list: "List issues",
  issue_search: "Search issues",
  issue_context: "Get issue context",
  issue_checkout: "Check out issue",
  issue_comment: "Add issue comment",
  issue_comments_list: "List issue comments",
  issue_comments_get: "Get issue comment",
  issue_update: "Update issue",
  issue_review: "Review issue",
  issue_commit: "Record issue commit",
  issue_done: "Mark issue done",
  issue_block: "Block issue",
  project_list: "List projects",
  project_get: "Get project",
  project_create: "Create project",
  project_update: "Update project",
  user_activity: "Get user activity",
  library_file_list: "List library files",
  library_file_get: "Get library file",
  library_file_ref: "Get library file reference",
  library_file_link: "Get library file reference",
  library_file_put: "Save library file",
  approval_get: "Get approval",
  approval_issues: "List approval issues",
  approval_comment: "Add approval comment",
  skill_list: "List skills",
  skill_get: "Get skill",
  skill_file: "Get skill file",
  skill_import: "Import skill",
  skill_scan_local: "Scan local skills",
  skill_scan_projects: "Scan project skills",
  automation_list: "List automations",
  automation_get: "Get automation",
  automation_runs: "List automation runs",
  automation_triggers_list: "List automation triggers",
  automation_triggers_create: "Create automation trigger",
  automation_triggers_update: "Update automation trigger",
  automation_triggers_delete: "Delete automation trigger",
  automation_triggers_rotate_secret: "Rotate automation trigger secret",
  automation_create: "Create automation",
  automation_update: "Update automation",
  automation_enable: "Enable automation",
  automation_disable: "Disable automation",
  automation_run: "Run automation",
  chat_list: "List chats",
  chat_search: "Search chats",
  chat_get: "Get chat",
  chat_messages: "List chat messages",
  chat_transcript: "Read chat transcript",
  chat_read: "Read chat",
  chat_create: "Create chat",
  chat_send: "Send chat message",
  chat_archive: "Archive chat",
  runs_list: "List runs",
  runs_by_skill: "List runs by skill",
  runs_get: "Get run",
  runs_events: "List run events",
  runs_log: "Read run log",
  runs_transcript: "Read run transcript",
  runs_errors: "List run errors",
  runs_cancel: "Cancel run",
  runs_retry: "Retry run",

  browser_tabs: "List browser tabs",
  browser_user_tabs: "List user browser tabs",
  browser_open: "Open browser tab",
  browser_navigate: "Navigate browser",
  browser_back: "Navigate browser back",
  browser_forward: "Navigate browser forward",
  browser_reload: "Reload browser tab",
  browser_viewport: "Manage browser viewport",
  browser_visibility: "Manage browser visibility",
  browser_snapshot: "Capture browser snapshot",
  browser_locator: "Inspect browser element",
  browser_cua: "Interact with browser",
  browser_dom_cua: "Inspect browser DOM",
  browser_dialog: "Handle browser dialog",
  browser_clipboard: "Use browser clipboard",
  browser_logs: "Get browser logs",
  browser_download: "Download browser asset",
  browser_assets: "Get browser assets",
  browser_content: "Read browser content",
  browser_wait: "Wait for browser state",
  browser_read: "Read browser snapshot",
  browser_click: "Click browser element",
  browser_type: "Type in browser",
  browser_screenshot: "Capture browser screenshot",
  browser_close: "Close browser tab",
};

const MCP_SUMMARY_ACTION_LABELS: Readonly<Record<string, string>> = {
  get: "Get",
  fetch: "Get",
  retrieve: "Get",
  list: "List",
  create: "Create",
  update: "Update",
  patch: "Update",
  delete: "Delete",
  remove: "Delete",
  read: "Read",
  search: "Search",
  find: "Search",
  query: "Search",
  navigate: "Navigate",
  open: "Open",
  enable: "Enable",
  disable: "Disable",
  run: "Run",
  execute: "Run",
  sync: "Sync",
  archive: "Archive",
  send: "Send",
  cancel: "Cancel",
  retry: "Retry",
  import: "Import",
  export: "Export",
  scan: "Scan",
  inspect: "Inspect",
  capture: "Capture",
  record: "Record",
  propose: "Propose",
  review: "Review",
  block: "Block",
  checkout: "Check out",
  add: "Add",
  mark: "Mark",
  save: "Save",
  reload: "Reload",
  download: "Download",
  click: "Click",
  type: "Type",
  wait: "Wait",
  handle: "Handle",
  manage: "Manage",
  interact: "Interact",
};

const MCP_SUMMARY_IGNORED_TOKENS = new Set([
  "call",
  "function",
  "functions",
  "invocation",
  "invoke",
  "tool",
  "use",
]);

function splitMcpSummaryTokens(value: string): string[] {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function normalizeMcpSummaryKey(value: string): string {
  return splitMcpSummaryTokens(value).join("_");
}

function isRudderMcpServer(server: string | null): boolean {
  return MCP_RUDDER_SERVER_ALIASES.has(normalizeMcpSummaryKey(server ?? ""));
}

function startsWithTokenSequence(tokens: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.every((token, index) => tokens[index] === token);
}

function normalizeMcpToolForSummary(tool: string, server: string | null): string {
  const tokens = splitMcpSummaryTokens(tool);
  if (isRudderMcpServer(server) && tokens[0] === "rudder") {
    tokens.shift();
  }

  const serverTokens = splitMcpSummaryTokens(server ?? "");
  const possibleServerPrefixes = serverTokens.length > 1
    ? [serverTokens, [serverTokens[0]!]]
    : [serverTokens];
  const serverPrefix = possibleServerPrefixes.find((prefix) => startsWithTokenSequence(tokens, prefix));
  if (serverPrefix) tokens.splice(0, serverPrefix.length);

  return tokens.join("_");
}

function humanizeMcpTokens(tokens: string[]): string {
  return tokens
    .filter(Boolean)
    .map((token) => MCP_SUMMARY_TOKEN_LABELS[token] ?? token)
    .join(" ");
}

function titleCaseMcpSummary(value: string): string {
  if (!value) return "Unknown action";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function pluralizeMcpSummaryObject(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  const last = tokens.at(-1)!;
  if (last.endsWith("s") || last === "data") return tokens;
  if (last.endsWith("y") && !/[aeiou]y$/.test(last)) {
    return [...tokens.slice(0, -1), `${last.slice(0, -1)}ies`];
  }
  if (/(?:s|x|z|ch|sh)$/.test(last)) {
    return [...tokens.slice(0, -1), `${last}es`];
  }
  return [...tokens.slice(0, -1), `${last}s`];
}

function formatGenericMcpSummary(toolKey: string): string {
  const rawTokens = toolKey.split("_").filter(Boolean);
  const tokens = rawTokens.filter((token) => !MCP_SUMMARY_IGNORED_TOKENS.has(token));
  if (tokens.length === 0) return "Unknown action";

  const actionIndex = tokens.findIndex((token) => Object.prototype.hasOwnProperty.call(MCP_SUMMARY_ACTION_LABELS, token));
  if (actionIndex < 0) return titleCaseMcpSummary(humanizeMcpTokens(tokens));

  const actionToken = tokens[actionIndex]!;
  const action = MCP_SUMMARY_ACTION_LABELS[actionToken]!;
  const objectTokens = tokens.filter((_, index) => index !== actionIndex);
  const displayObjectTokens = actionToken === "list"
    ? pluralizeMcpSummaryObject(objectTokens)
    : objectTokens;
  const object = humanizeMcpTokens(displayObjectTokens);
  return object ? `${action} ${object}` : action;
}

export function formatMcpSummary(details: McpToolDetails): string {
  const rawTool = details.tool?.trim();
  if (!rawTool) return "Unknown action";

  const normalizedTool = normalizeMcpSummaryKey(rawTool);
  const contextualTool = normalizeMcpToolForSummary(rawTool, details.server);
  const ruleKeys = isRudderMcpServer(details.server)
    ? [contextualTool]
    : [normalizedTool, contextualTool];
  const rule = ruleKeys.map((key) => MCP_SUMMARY_TOOL_RULES[key]).find(Boolean);
  return rule ?? formatGenericMcpSummary(contextualTool);
}

export function formatTargetAction(
  verb: string,
  targets: string[],
  singular: TranscriptToolSemanticInfo["noun"],
  fallback: string,
  useDisplayLabels = false,
): Pick<TranscriptToolSemanticInfo, "summary" | "quantity" | "noun"> {
  if (targets.length === 1) {
    return {
      summary: `${verb} ${useDisplayLabels ? transcriptArtifactBasename(targets[0]!) : targets[0]}`,
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
  const fileComment = extractShellFlagValue(tokens, "--comment-file") ?? extractShellFlagValue(tokens, "--body-file");
  if (fileComment) {
    return fileComment === "-" ? "added stdin comment" : "added file-backed comment";
  }

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

export function describeCommandSemanticInfo(
  command: string,
  record: Record<string, unknown> | null = null,
): TranscriptToolSemanticInfo {
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
        actionKind: "skill",
        category: "skill",
        fileTargets: createTranscriptSkillTargets(targets, record),
        label: "Use skill",
        bucket: "explore",
        skillTargets: createTranscriptSkillTargets(targets, record),
      };
    }
    const action = formatTargetAction("Read", targets, "file", "Read file", true);
    return {
      ...action,
      actionKind: "read",
      category: invocation.category,
      label: invocation.label,
      bucket: "read",
      fileTargets: createTranscriptFileTargets(targets, record),
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
    const action = formatTargetAction("Edited", targets, "file", "Edited files", true);
    return {
      ...action,
      category: invocation.category,
      label: invocation.label,
      bucket: "edit",
      fileTargets: createTranscriptFileTargets(targets, record),
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

  const namedAction = describeToolNameAction(name);
  if (namedAction) return namedAction;

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

export function splitToolNameWords(name: string): string[] {
  return name
    .split(/[:/.]+/)
    .pop()
    ?.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean) ?? [];
}

function describeToolNameAction(name: string): { category: TranscriptToolCategory; label: string } | null {
  const words = splitToolNameWords(name).filter((word) => !["tool", "call", "use", "invocation", "function", "functions"].includes(word));
  const has = (...candidates: string[]) => words.some((word) => candidates.includes(word));

  if (has("read", "fetch", "open", "cat", "view")) {
    return { category: "read", label: "Read" };
  }
  if (has("edit", "write", "patch", "apply", "replace", "create", "delete", "remove")) {
    return { category: "edit", label: "Edit" };
  }
  if (has("grep", "search", "find", "glob", "match")) {
    return { category: words.includes("grep") ? "grep" : "search", label: "Search" };
  }
  if (has("list", "ls", "tree", "browse")) {
    return { category: "list", label: "Explore" };
  }
  if (has("inspect", "show", "status", "diff", "log", "get")) {
    return { category: "inspect", label: "Inspect" };
  }

  return null;
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

function normalizeCodexToolName(name: string): string {
  return name.trim().toLowerCase().split(".").pop()?.replace(/-/g, "_") ?? "";
}

function summarizeCodexAgentItems(input: Record<string, unknown>): string | null {
  const items = input.items;
  if (!Array.isArray(items) || items.length === 0) return null;

  const firstText = items
    .map((item) => asRecord(item))
    .find((item): item is Record<string, unknown> => Boolean(item && typeof item.text === "string" && item.text.trim()));
  if (firstText && typeof firstText.text === "string") {
    return truncate(compactWhitespace(firstText.text), 120);
  }

  return items.length === 1 ? "1 attached item" : `${items.length} attached items`;
}

function readCodexAgentReceivers(record: Record<string, unknown>): string[] {
  const values = Array.isArray(record.receiver_thread_ids)
    ? record.receiver_thread_ids
    : Array.isArray(record.receiverThreadIds)
      ? record.receiverThreadIds
      : [];
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function describeCodexAgentToolSemanticInfo(name: string, input: unknown): TranscriptToolSemanticInfo | null {
  const toolName = normalizeCodexToolName(name);
  const record = asRecord(input);
  if (!record) return null;

  if (toolName === "spawn_agent") {
    const agentType = readStringField(record, ["agent_type", "agentType", "type"]);
    const task =
      summarizeRecord(record, ["message", "task", "prompt", "instructions"])
      ?? summarizeCodexAgentItems(record);
    const receiverThreadIds = readCodexAgentReceivers(record);
    const receiver = receiverThreadIds[0];
    const model = readStringField(record, ["model"]);
    const reasoningEffort = readStringField(record, ["reasoning_effort", "reasoningEffort"]);
    const context = record.fork_context === true || record.forkContext === true ? "forked context" : null;
    const details = [model, reasoningEffort ? `${reasoningEffort} reasoning` : null, context].filter(Boolean);
    const agentLabel = receiver
      ? `agent ${truncate(receiver, 24)}`
      : agentType
        ? `${agentType} agent`
        : "agent";
    const summary = task
      ? `Spawned ${agentLabel}: ${task}`
      : `Spawned ${agentLabel}`;

    return {
      category: "tool",
      label: "Spawn agent",
      summary: details.length > 0 ? `${summary} (${details.join(", ")})` : summary,
      bucket: "tool",
      quantity: 1,
      noun: "tool",
    };
  }

  if (toolName === "subagent_activity") {
    const activityKind = readStringField(record, ["activity_kind", "activityKind", "kind"]) ?? "updated";
    const agentPath = readStringField(record, ["agent_path", "agentPath"]);
    const agentName = agentPath?.split("/").filter(Boolean).at(-1)?.replace(/[_-]+/g, " ") ?? null;
    const receiver = readCodexAgentReceivers(record)[0];
    const label = agentName ?? (receiver ? truncate(receiver, 24) : "sub-agent");
    const verb = activityKind === "started"
      ? "Spawned"
      : activityKind === "interrupted"
        ? "Interrupted"
        : activityKind === "completed"
          ? "Completed"
          : "Updated";
    return {
      category: "tool",
      label: "Sub-agent activity",
      summary: `${verb} ${label} agent`,
      bucket: "tool",
      quantity: 1,
      noun: "tool",
    };
  }

  if (toolName === "wait_agent") {
    const targets = Array.isArray(record.targets)
      ? record.targets.filter((target): target is string => typeof target === "string" && target.trim().length > 0)
      : readCodexAgentReceivers(record);
    return {
      category: "tool",
      label: "Wait for agent",
      summary: targets.length > 0
        ? `Waited for ${targets.length === 1 ? `agent ${truncate(targets[0]!, 16)}` : `${targets.length} agents`}`
        : "Waited for agents",
      bucket: "tool",
      quantity: Math.max(targets.length, 1),
      noun: "tool",
    };
  }

  if (toolName === "send_input") {
    const target = readStringField(record, ["target", "agent_id", "thread_id"]) ?? readCodexAgentReceivers(record)[0];
    const message = summarizeRecord(record, ["message"]) ?? summarizeCodexAgentItems(record);
    return {
      category: "tool",
      label: "Message agent",
      summary: message
        ? `Messaged ${target ? `agent ${truncate(target, 16)}` : "agent"}: ${message}`
        : `Messaged ${target ? `agent ${truncate(target, 16)}` : "agent"}`,
      bucket: "tool",
      quantity: 1,
      noun: "tool",
    };
  }

  if (toolName === "close_agent") {
    const target = readStringField(record, ["target", "agent_id", "thread_id"]) ?? readCodexAgentReceivers(record)[0];
    return {
      category: "tool",
      label: "Close agent",
      summary: target ? `Closed agent ${truncate(target, 16)}` : "Closed agent",
      bucket: "tool",
      quantity: 1,
      noun: "tool",
    };
  }

  if (toolName === "resume_agent") {
    const target = readStringField(record, ["target", "agent_id", "thread_id"]) ?? readCodexAgentReceivers(record)[0];
    return {
      category: "tool",
      label: "Resume agent",
      summary: target ? `Resumed agent ${truncate(target, 24)}` : "Resumed agent",
      bucket: "tool",
      quantity: 1,
      noun: "tool",
    };
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

export function neutralizeToolFailureSemanticInfo(
  semantic: TranscriptToolSemanticInfo,
): TranscriptToolSemanticInfo {
  if (semantic.actionKind === "file_change" && semantic.summary === "File change failed") {
    return { ...semantic, summary: "File changes" };
  }
  return semantic;
}

export function describeToolSemanticInfo(name: string, input: unknown, result?: string): TranscriptToolSemanticInfo {
  const normalizedName = name.trim().toLowerCase();
  const normalizedIdentifier = normalizedName.replace(/[\s_-]+/g, "");
  const record = asRecord(input);

  if (normalizedIdentifier === "imageview") {
    const sourcePath = readStringField(record, ["path"]);
    const status = readStringField(record, ["status"])?.toLowerCase() ?? "";
    const failed = ["failed", "error", "errored", "cancelled", "canceled", "denied", "rejected"]
      .includes(status);
    const durableAssetPath = sourcePath?.startsWith("/api/assets/") ? sourcePath : null;
    const target = sourcePath ? createTranscriptFileTargets([sourcePath], record)[0] : null;
    const displayLabel = readStringField(record, ["displayName", "display_name", "name"]) ?? (sourcePath
      ? sourcePath.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter(Boolean).at(-1) ?? sourcePath
      : "image");
    return {
      actionKind: "image_view",
      category: "image",
      label: "View image",
      summary: "Viewed an image",
      bucket: "explore",
      quantity: 1,
      noun: "item",
      ...(!failed && (durableAssetPath || target?.path) ? {
        image: {
          displayLabel,
          path: durableAssetPath ?? target!.path!,
        },
      } : {}),
    };
  }

  const codexAgentToolInfo = describeCodexAgentToolSemanticInfo(name, input);
  if (codexAgentToolInfo) {
    return codexAgentToolInfo;
  }

  if (normalizedName === "image_view") {
    const sourcePath = readStringField(record, ["path"]);
    const durableAssetPath = sourcePath?.startsWith("/api/assets/") ? sourcePath : null;
    const target = sourcePath ? createTranscriptFileTargets([sourcePath], record)[0] : null;
    return {
      actionKind: "image_view",
      category: "image",
      label: "View image",
      summary: "Viewed an image",
      bucket: "explore",
      quantity: 1,
      noun: "item",
      ...(durableAssetPath || target?.path ? {
        image: {
          displayLabel: readStringField(record, ["displayName", "display_name", "name"])
            ?? target?.displayLabel
            ?? "image",
          path: durableAssetPath ?? target!.path!,
        },
      } : {}),
    };
  }

  if (normalizedName === "file_change") {
    const fileChanges = extractFileChangeEvidence(input);
    const fileCount = fileChangeEvidenceCount(record, fileChanges.length);
    const inputStatus = readStringField(record, ["status"])?.toLowerCase();
    const summary = fileCount > 0
      ? `Edited ${fileCount} ${pluralize("file", fileCount)}`
      : inputStatus === "failed" || inputStatus === "error"
        ? "File change failed"
        : "File changes";
    return {
      actionKind: "file_change",
      category: "edit",
      label: "Edit files",
      summary,
      bucket: "edit",
      quantity: fileCount,
      noun: "file",
      fileChanges,
      evidenceWarning: formatFileChangeEvidenceWarning(input) ?? undefined,
    };
  }

  if (normalizedName === "skill") {
    const skill = readStringField(record, ["skill", "name"]);
    const skillAction = skill ? formatSkillUseAction([skill]) : null;
    const explicitPath = readStringField(record, ["path", "sourcePath", "source_path", "skillPath", "skill_path"]);
    const baseDirectory = result?.match(/^Base directory(?: for this skill)?:\s*(.+)$/mi)?.[1]?.trim() ?? null;
    const sourcePath = explicitPath
      ?? (baseDirectory ? `${baseDirectory.replace(/[\\/]+$/u, "")}/SKILL.md` : null);
    const resolvedPath = sourcePath
      ? createTranscriptFileTargets([sourcePath], record)[0]?.path ?? null
      : null;
    const paths = extractRecordPaths(record);
    const skillTargets = skill ? [{ name: skill, path: resolvedPath }] : [];
    return {
      actionKind: "skill",
      category: "skill",
      fileTargets: createTranscriptSkillTargets(
        sourcePath ? [...paths, sourcePath] : paths,
        record,
      ),
      label: "Use skill",
      summary: skillAction?.summary ?? "Use skill",
      bucket: "explore",
      quantity: 1,
      noun: "skill",
      skillTargets,
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
    return describeCommandSemanticInfo(command, record);
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
        actionKind: "skill",
        category: "skill",
        fileTargets: createTranscriptSkillTargets(paths, record),
        label: "Use skill",
        bucket: "explore",
        skillTargets: createTranscriptSkillTargets(paths, record),
      };
    }
    const action = formatTargetAction("Read", paths, "file", "Read file", true);
    return {
      ...action,
      actionKind: "read",
      category: invocation.category,
      label: invocation.label,
      bucket: "read",
      fileTargets: createTranscriptFileTargets(paths, record),
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
    const action = formatTargetAction("Edited", paths, "file", "Edited files", true);
    return {
      ...action,
      category: invocation.category,
      label: invocation.label,
      bucket: "edit",
      fileTargets: createTranscriptFileTargets(paths, record),
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

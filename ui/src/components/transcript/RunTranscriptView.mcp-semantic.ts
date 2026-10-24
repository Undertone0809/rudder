import { asRecord, compactWhitespace, truncate } from "./RunTranscriptView.common";
import { quoteSummaryText } from "./RunTranscriptView.summary";

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

const MCP_SEARCH_QUERY_KEYS = ["query", "q", "search_query", "searchQuery"] as const;
const MCP_SEARCH_ACTION_TOKENS = new Set(["search", "find", "query"]);

export function extractMcpSearchQuery(details: McpToolDetails): string | null {
  for (const key of MCP_SEARCH_QUERY_KEYS) {
    const value = details.args?.[key];
    if (typeof value === "string" && value.trim()) return compactWhitespace(value);
  }
  return null;
}

export function extractMcpSearchExtraArgs(details: McpToolDetails): Record<string, unknown> | null {
  if (!isMcpSearchTool(details) || !extractMcpSearchQuery(details) || !details.args) return null;
  const extraArgs = Object.fromEntries(
    Object.entries(details.args).filter(([key]) => !MCP_SEARCH_QUERY_KEYS.includes(key as typeof MCP_SEARCH_QUERY_KEYS[number])),
  );
  return Object.keys(extraArgs).length > 0 ? extraArgs : null;
}

export function isMcpSearchTool(details: McpToolDetails): boolean {
  const tool = details.tool?.trim();
  if (!tool) return false;
  const contextualTool = normalizeMcpToolForSummary(tool, details.server);
  const firstActionToken = splitMcpSummaryTokens(contextualTool)
    .find((token) => Object.prototype.hasOwnProperty.call(MCP_SUMMARY_ACTION_LABELS, token));
  return firstActionToken ? MCP_SEARCH_ACTION_TOKENS.has(firstActionToken) : false;
}

export function formatMcpSearchQuery(details: McpToolDetails): string | null {
  if (!isMcpSearchTool(details)) return null;
  const query = extractMcpSearchQuery(details);
  return query ? quoteSummaryText(query) : null;
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
  const summary = rule ?? formatGenericMcpSummary(contextualTool);
  const query = formatMcpSearchQuery(details);
  return query ? `${summary} for ${query}` : summary;
}

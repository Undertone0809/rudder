import { type TranscriptEntry, type TranscriptTodoItemStatus } from "@rudderhq/agent-runtime-utils";
import { isCodexClosedStdinToolSessionError } from "../shared/tool-errors.js";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function toolResultContent(item: Record<string, unknown>, fallback: string): string {
  return (
    firstString(item.content, item.output, item.result, item.aggregated_output) ||
    stringifyUnknown(item.content ?? item.output ?? item.result) ||
    fallback
  );
}

function isToolError(item: Record<string, unknown>): boolean {
  const status = asString(item.status).toLowerCase();
  return (
    item.is_error === true ||
    item.error === true ||
    status === "error" ||
    status === "failed" ||
    status === "errored"
  );
}

function normalizeTodoStatus(item: Record<string, unknown>): TranscriptTodoItemStatus {
  const rawStatus = asString(item.status) || asString(item.state);
  const normalizedStatus = rawStatus.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalizedStatus === "completed" || normalizedStatus === "complete" || normalizedStatus === "done") {
    return "completed";
  }
  if (normalizedStatus === "in_progress" || normalizedStatus === "running" || normalizedStatus === "active" || normalizedStatus === "current") {
    return "in_progress";
  }
  if (item.completed === true) return "completed";
  if (item.in_progress === true || item.current === true || item.active === true) return "in_progress";
  return "pending";
}

function parseTodoListItem(item: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const rawItems = Array.isArray(item.items) ? item.items : [];
  const items = rawItems
    .map((rawItem) => asRecord(rawItem))
    .filter((todoItem): todoItem is Record<string, unknown> => Boolean(todoItem))
    .map((todoItem) => {
      const text = asString(todoItem.text) || asString(todoItem.title) || asString(todoItem.content) || asString(todoItem.task);
      if (!text.trim()) return null;
      return {
        text,
        status: normalizeTodoStatus(todoItem),
      };
    })
    .filter((todoItem): todoItem is { text: string; status: TranscriptTodoItemStatus } => Boolean(todoItem));

  if (items.length === 0) return [];

  const id = asString(item.id);
  return [{
    kind: "todo_list",
    ts,
    todoListId: id || undefined,
    items,
  }];
}

function parseCodexItemUpdated(item: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const itemType = asString(item.type);

  if (itemType === "todo_list") {
    return parseTodoListItem(item, ts);
  }

  const id = asString(item.id);
  const status = asString(item.status);
  const meta = [id ? `id=${id}` : "", status ? `status=${status}` : ""].filter(Boolean).join(" ");
  return [{
    kind: "system",
    ts,
    text: `item updated: ${itemType || "unknown"}${meta ? ` (${meta})` : ""}`,
  }];
}

function parseCommandExecutionItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const id = asString(item.id);
  const command = asString(item.command);
  const status = asString(item.status);
  const exitCode = typeof item.exit_code === "number" && Number.isFinite(item.exit_code) ? item.exit_code : null;
  const safeCommand = command;
  const output = asString(item.aggregated_output).replace(/\s+$/, "");

  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name: "command_execution",
      toolUseId: id || command || "command_execution",
      input: {
        id,
        command: safeCommand,
      },
    }];
  }

  const lines: string[] = [];
  if (safeCommand) lines.push(`command: ${safeCommand}`);
  if (status) lines.push(`status: ${status}`);
  if (exitCode !== null) lines.push(`exit_code: ${exitCode}`);
  if (output) {
    if (lines.length > 0) lines.push("");
    lines.push(output);
  }

  const isError =
    (exitCode !== null && exitCode !== 0) ||
    status === "failed" ||
    status === "errored" ||
    status === "error" ||
    status === "cancelled";
  if (isError && isCodexClosedStdinToolSessionError(output)) return [];

  return [{
    kind: "tool_result",
    ts,
    toolUseId: id || command || "command_execution",
    content: lines.join("\n").trim() || "command completed",
    isError,
  }];
}

function parseFileChangeItem(item: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const entries = changes
    .map((changeRaw) => asRecord(changeRaw))
    .filter((change): change is Record<string, unknown> => Boolean(change))
    .map((change) => {
      const kind = asString(change.kind, "update");
      const path = asString(change.path, "unknown");
      return `${kind} ${path}`;
    });

  if (entries.length === 0) {
    return [{ kind: "system", ts, text: "file changes applied" }];
  }

  const preview = entries.slice(0, 6).join(", ");
  const more = entries.length > 6 ? ` (+${entries.length - 6} more)` : "";
  return [{ kind: "system", ts, text: `file changes: ${preview}${more}` }];
}

function parseWebSearchItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const id = asString(item.id) || "web_search";
  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name: "web_search",
      toolUseId: id,
      input: {
        id,
        action: item.action ?? item,
      },
    }];
  }

  const content = toolResultContent(item, "web search completed");
  const isError = isToolError(item);
  if (isError && isCodexClosedStdinToolSessionError(content)) return [];
  return [{ kind: "tool_result", ts, toolUseId: id, toolName: "web_search", content, isError }];
}

function parseMcpToolCallItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const id = asString(item.id) || asString(item.call_id) || "mcp_tool_call";
  const invocation = asRecord(item.invocation) ?? asRecord(item.request) ?? item;
  const server = firstString(
    invocation.server,
    invocation.serverName,
    invocation.server_name,
    invocation.serverLabel,
    invocation.server_label,
    item.server,
    item.serverName,
    item.server_name,
  );
  const tool = firstString(
    invocation.tool,
    invocation.toolName,
    invocation.tool_name,
    invocation.name,
    item.tool,
    item.toolName,
    item.tool_name,
    item.name,
  );
  const safeServer = server.replace(/[^A-Za-z0-9_-]+/g, "_");
  const safeTool = tool.replace(/[^A-Za-z0-9_-]+/g, "_");
  const name = safeServer && safeTool ? `mcp__${safeServer}__${safeTool}` : "mcp_tool_call";

  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name,
      toolUseId: id,
      input: {
        id,
        server,
        tool,
        invocation,
        args:
          invocation.arguments ??
          invocation.args ??
          invocation.params ??
          item.arguments ??
          item.args ??
          item.params,
      },
    }];
  }

  const content = toolResultContent(item, "mcp tool completed");
  const isError = isToolError(item);
  if (isError && isCodexClosedStdinToolSessionError(content)) return [];
  return [{ kind: "tool_result", ts, toolUseId: id, toolName: name, content, isError }];
}

function parseCodexItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const itemType = asString(item.type);

  if (itemType === "todo_list") {
    return parseTodoListItem(item, ts);
  }

  if (itemType === "agent_message") {
    const text = asString(item.text);
    if (text) return [{ kind: "assistant", ts, text }];
    return [];
  }

  if (itemType === "reasoning") {
    const text = asString(item.text);
    if (text) return [{ kind: "thinking", ts, text }];
    return [{ kind: "system", ts, text: phase === "started" ? "reasoning started" : "reasoning completed" }];
  }

  if (itemType === "command_execution") {
    return parseCommandExecutionItem(item, ts, phase);
  }

  if (itemType === "web_search") {
    return parseWebSearchItem(item, ts, phase);
  }

  if (itemType === "mcp_tool_call" || itemType === "mcp_tool_call_begin" || itemType === "mcp_tool_call_end") {
    return parseMcpToolCallItem(item, ts, phase);
  }

  if (itemType === "file_change" && phase === "completed") {
    return parseFileChangeItem(item, ts);
  }

  if (itemType === "tool_use") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(item.name, "unknown"),
      toolUseId: asString(item.id),
      input: item.input ?? {},
    }];
  }

  if (itemType === "tool_result" && phase === "completed") {
    const toolUseId = asString(item.tool_use_id, asString(item.id));
    const content =
      asString(item.content) ||
      asString(item.output) ||
      asString(item.result) ||
      stringifyUnknown(item.content ?? item.output ?? item.result);
    const isError = item.is_error === true || asString(item.status) === "error";
    if (isError && isCodexClosedStdinToolSessionError(content)) return [];
    return [{ kind: "tool_result", ts, toolUseId, content, isError }];
  }

  if (itemType === "error" && phase === "completed") {
    const text = errorText(item.message ?? item.error ?? item);
    if (isCodexClosedStdinToolSessionError(text)) return [];
    return [{ kind: "stderr", ts, text: text || "error" }];
  }

  const id = asString(item.id);
  const status = asString(item.status);
  const meta = [id ? `id=${id}` : "", status ? `status=${status}` : ""].filter(Boolean).join(" ");
  return [{
    kind: "system",
    ts,
    text: `item ${phase}: ${itemType || "unknown"}${meta ? ` (${meta})` : ""}`,
  }];
}

export function parseCodexStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "thread.started") {
    const threadId = asString(parsed.thread_id);
    return [{
      kind: "init",
      ts,
      model: asString(parsed.model, "codex"),
      sessionId: threadId,
    }];
  }

  if (type === "turn.started") {
    return [{ kind: "system", ts, text: "turn started" }];
  }

  if (type === "item.started" || type === "item.completed") {
    const item = asRecord(parsed.item);
    if (!item) return [{ kind: "system", ts, text: type.replace(".", " ") }];
    return parseCodexItem(item, ts, type === "item.started" ? "started" : "completed");
  }

  if (type === "item.updated") {
    const item = asRecord(parsed.item);
    if (!item) return [{ kind: "system", ts, text: "item updated" }];
    return parseCodexItemUpdated(item, ts);
  }

  if (type === "turn.completed") {
    const usage = asRecord(parsed.usage);
    const inputTokens = asNumber(usage?.input_tokens);
    const outputTokens = asNumber(usage?.output_tokens);
    const cachedTokens = asNumber(usage?.cached_input_tokens, asNumber(usage?.cache_read_input_tokens));
    return [{
      kind: "result",
      ts,
      text: asString(parsed.result),
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd: asNumber(parsed.total_cost_usd),
      subtype: asString(parsed.subtype),
      isError: parsed.is_error === true,
      errors: Array.isArray(parsed.errors)
        ? parsed.errors.map(errorText).filter(Boolean)
        : [],
    }];
  }

  if (type === "turn.failed") {
    const usage = asRecord(parsed.usage);
    const inputTokens = asNumber(usage?.input_tokens);
    const outputTokens = asNumber(usage?.output_tokens);
    const cachedTokens = asNumber(usage?.cached_input_tokens, asNumber(usage?.cache_read_input_tokens));
    const message = errorText(parsed.error ?? parsed.message);
    if (isCodexClosedStdinToolSessionError(message)) return [];
    return [{
      kind: "result",
      ts,
      text: asString(parsed.result),
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd: asNumber(parsed.total_cost_usd),
      subtype: asString(parsed.subtype, "turn.failed"),
      isError: true,
      errors: message ? [message] : [],
    }];
  }

  if (type === "error") {
    const message = errorText(parsed.message ?? parsed.error ?? parsed);
    if (isCodexClosedStdinToolSessionError(message)) return [];
    return [{ kind: "stderr", ts, text: message || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

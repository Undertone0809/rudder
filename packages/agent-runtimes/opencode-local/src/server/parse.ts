import { asNumber, asString, parseJson, parseObject } from "@rudderhq/agent-runtime-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function isOpenCodeContinuationSummaryText(text: string): boolean {
  if (
    text.startsWith("## Goal\n") &&
    text.includes("\n## Constraints & Preferences\n") &&
    text.includes("\n## Progress\n") &&
    text.includes("\n## Next Steps\n") &&
    text.includes("\n## Critical Context\n")
  ) {
    return true;
  }
  return (
    text.startsWith("## Goal\n") &&
    text.includes("\n## Progress\n") &&
    text.includes("\n## Critical Context\n") &&
    text.includes("\n## Relevant Files\n")
  );
}

function isOpenCodeCompletionContinuationText(text: string): boolean {
  if (!isOpenCodeContinuationSummaryText(text)) return false;
  const progressSection = text.split("\n## Progress\n")[1]?.split(/\n## [^\n]+\n/)[0] ?? "";
  const nextStepsSection = text.split("\n## Next Steps\n")[1]?.split(/\n## [^\n]+\n/)[0] ?? "";
  const lower = `${progressSection}\n${nextStepsSection}`.toLowerCase();
  return (
    /\btask complete\b/.test(lower) ||
    /\bcomplete[d]?\b/.test(lower) && /\bcalled\b.*\brudder_/.test(lower) ||
    /\bin progress\s*\n-\s*\(none\)/.test(lower) && /\bcalled\b.*\brudder_/.test(lower)
  );
}

function isOpenCodeSyntheticContinuationText(text: string, part: Record<string, unknown>): boolean {
  const metadata = parseObject(part.metadata);
  if (part.synthetic === true || metadata.compaction_continue === true) return true;
  return isOpenCodeContinuationSummaryText(text);
}

function isOpenCodeProviderToolCallText(text: string): boolean {
  return /^<tool_call>\s*<function=[\s\S]*<\/function>\s*<\/tool_call>$/.test(text.trim());
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;
  let terminalStop = false;
  let completionSummary: string | null = null;
  let modelOutputObserved = false;
  let toolActivityObserved = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const parsedLine = parseOpenCodeJsonlLine(line);
    if (!parsedLine) continue;
    const { event } = parsedLine;
    if (asString(event.type, "") === "tool_use") toolActivityObserved = true;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    if (parsedLine.type === "assistantText") {
      if (parsedLine.text) {
        messages.push(parsedLine.text);
        modelOutputObserved = true;
      }
      continue;
    }

    if (parsedLine.type === "syntheticText") {
      if (parsedLine.completion && parsedLine.text) completionSummary = parsedLine.text;
      continue;
    }

    if (parsedLine.type === "terminalStop") {
      terminalStop = true;
    }

    if (
      parsedLine.type === "stepFinish" ||
      parsedLine.type === "toolCallsStepFinish" ||
      parsedLine.type === "terminalStop"
    ) {
      if (parsedLine.type === "toolCallsStepFinish") toolActivityObserved = true;
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (parsedLine.type === "toolUseError") {
      toolActivityObserved = true;
      if (parsedLine.text) errors.push(parsedLine.text);
      continue;
    }

    if (parsedLine.type === "error") {
      if (parsedLine.text) errors.push(parsedLine.text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    terminalStop,
    completionSummary,
    modelOutputObserved,
    toolActivityObserved,
  };
}

export type OpenCodeJsonlLine =
  | { type: "assistantText"; text: string; event: Record<string, unknown> }
  | { type: "syntheticText"; text: string; completion: boolean; event: Record<string, unknown> }
  | { type: "terminalStop"; event: Record<string, unknown> }
  | { type: "stepFinish"; event: Record<string, unknown> }
  | { type: "toolCallsStepFinish"; event: Record<string, unknown> }
  | { type: "toolUseError"; text: string; event: Record<string, unknown> }
  | { type: "error"; text: string; event: Record<string, unknown> }
  | { type: "other"; event: Record<string, unknown> };

export function parseOpenCodeJsonlLine(line: string): OpenCodeJsonlLine | null {
  const event = parseJson(line);
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const record = event as Record<string, unknown>;
  const type = asString(record.type, "");

  if (type === "text") {
    const part = parseObject(record.part);
    const text = asString(part.text, "").trim();
    const synthetic = isOpenCodeSyntheticContinuationText(text, part);
    if (isOpenCodeProviderToolCallText(text)) return { type: "other", event: record };
    return synthetic
      ? { type: "syntheticText", text, completion: isOpenCodeCompletionContinuationText(text), event: record }
      : { type: "assistantText", text, event: record };
  }

  if (type === "step_finish") {
    const part = parseObject(record.part);
    const reason = asString(part.reason, "");
    if (reason === "stop") return { type: "terminalStop", event: record };
    if (reason === "tool-calls") return { type: "toolCallsStepFinish", event: record };
    return { type: "stepFinish", event: record };
  }

  if (type === "tool_use") {
    const part = parseObject(record.part);
    const state = parseObject(part.state);
    if (asString(state.status, "") === "error") {
      const text = asString(state.error, "").trim();
      if (text) return { type: "toolUseError", text, event: record };
    }
    return { type: "other", event: record };
  }

  if (type === "error") {
    const text = errorText(record.error ?? record.message).trim();
    return { type: "error", text, event: record };
  }

  return { type: "other", event: record };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}

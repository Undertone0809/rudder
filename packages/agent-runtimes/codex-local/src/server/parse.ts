import { asNumber, asString, parseJson, parseObject } from "@rudderhq/agent-runtime-utils/server-utils";
import { isCodexClosedStdinToolSessionError } from "../shared/tool-errors.js";

export function parseCodexJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let modelOutputObserved = false;
  let terminalResult: string | null = null;
  let terminalEventObserved = false;
  let terminalCompleted = false;
  let errorMessage: string | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "thread.started") {
      sessionId = asString(event.thread_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      terminalEventObserved = true;
      const msg = asString(event.message, "").trim();
      if (msg && !isCodexClosedStdinToolSessionError(msg)) errorMessage = msg;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event.item);
      if (asString(item.type, "") === "agent_message") {
        const text = asString(item.text, "");
        if (text) {
          messages.push(text);
          modelOutputObserved = true;
        }
      }
      continue;
    }

    if (type === "turn.completed") {
      terminalEventObserved = true;
      const usageObj = parseObject(event.usage);
      usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens);
      usage.cachedInputTokens = asNumber(usageObj.cached_input_tokens, usage.cachedInputTokens);
      usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens);
      terminalResult = asString(event.result, terminalResult ?? "") || terminalResult;
      terminalCompleted = true;
      continue;
    }

    if (type === "turn.failed") {
      terminalEventObserved = true;
      const err = parseObject(event.error);
      const msg = asString(err.message, "").trim();
      if (msg && !isCodexClosedStdinToolSessionError(msg)) errorMessage = msg;
    }
  }

  return {
    sessionId,
    summary: terminalCompleted ? messages.join("\n\n").trim() || terminalResult?.trim() || "" : "",
    modelOutputObserved,
    terminalEventObserved,
    terminalCompleted,
    usage,
    errorMessage,
  };
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|no rollout found for thread id/i.test(
    haystack,
  );
}

export function isCodexTransportDisconnectError(stdout: string, stderr: string): boolean {
  return /stream disconnected before completion:\s*error sending request for url\s+\(https:\/\/[^)\s]+\/v1\/responses\)/i.test(
    `${stdout}\n${stderr}`,
  );
}

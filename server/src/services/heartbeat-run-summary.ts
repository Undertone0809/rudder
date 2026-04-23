function truncateSummaryText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function collectMessageText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const record = asRecord(message);
  if (!record) return [];

  const lines: string[] = [];
  const direct = asString(record.text);
  if (direct) lines.push(direct);

  const content = Array.isArray(record.content) ? record.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type);
    if (type === "output_text" || type === "text" || type === "content") {
      const text = asString(part.text) || asString(part.content);
      if (text) lines.push(text);
    }
  }

  return lines;
}

function extractPiAgentEndMessage(messagesRaw: unknown): string | null {
  const messages = Array.isArray(messagesRaw) ? messagesRaw : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || asString(message.role) !== "assistant") continue;
    const text = collectMessageText(message.content).join("\n\n").trim();
    if (text) return text;
  }
  return null;
}

function extractFinalResponseFromStdout(stdout: unknown): string | null {
  if (typeof stdout !== "string" || !stdout.trim()) return null;

  const messages: string[] = [];
  let terminalResult = "";

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const record = asRecord(event);
    if (!record) continue;

    const type = asString(record.type);

    if (type === "assistant") {
      messages.push(...collectMessageText(record.message));
      continue;
    }

    if (type === "item.completed") {
      const item = asRecord(record.item);
      if (asString(item?.type) === "agent_message") {
        const text = asString(item?.text);
        if (text) messages.push(text);
      }
      continue;
    }

    if (type === "turn_end") {
      messages.push(...collectMessageText(record.message));
      continue;
    }

    if (type === "agent_end") {
      const text = extractPiAgentEndMessage(record.messages);
      if (text) messages.push(text);
      continue;
    }

    if (type === "result") {
      terminalResult = asString(record.result) || asString(record.text) || asString(record.response) || terminalResult;
    }
  }

  return truncateSummaryText(terminalResult || messages.join("\n\n").trim());
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  if (!summary.summary && !summary.result && !summary.message) {
    const extractedResult = extractFinalResponseFromStdout(resultJson.stdout);
    if (extractedResult) {
      summary.result = extractedResult;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

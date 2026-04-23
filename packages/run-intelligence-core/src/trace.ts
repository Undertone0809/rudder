import type { TranscriptEntry } from "@rudder/agent-runtime-utils";
import type { ObservedRunDetail, ObservedRunStep, ObservedRunTrace, ObservedRunTurn } from "./types.js";

function truncate(value: string, maxLength = 180) {
  const text = value.trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function firstMeaningfulLine(value: string) {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function formatJson(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function isModelTranscriptEntry(entry: TranscriptEntry) {
  return entry.kind === "assistant" || entry.kind === "thinking" || entry.kind === "result";
}

export function isPayloadTranscriptEntry(entry: TranscriptEntry) {
  return entry.kind === "tool_call" || entry.kind === "tool_result";
}

export function detailTextForTranscriptEntry(entry: TranscriptEntry) {
  if (entry.kind === "tool_call") return formatJson(entry.input);
  if (entry.kind === "tool_result") return entry.content || "";
  if (entry.kind === "result") {
    return [
      entry.text || "",
      entry.errors.length ? `Errors:\n${entry.errors.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (entry.kind === "init") return `model=${entry.model}\nsession=${entry.sessionId}`;
  return "text" in entry ? entry.text || "" : "";
}

export function previewTextForTranscriptEntry(entry: TranscriptEntry, maxLength = 180) {
  if (entry.kind === "tool_call") {
    return truncate(`${entry.name}(${formatJson(entry.input)})`, maxLength);
  }
  if (entry.kind === "tool_result") {
    const detail = detailTextForTranscriptEntry(entry);
    return truncate(firstMeaningfulLine(detail) || entry.toolName || "(empty tool result)", maxLength);
  }
  if (entry.kind === "result") {
    const summary = entry.text ? firstMeaningfulLine(entry.text) : "";
    if (summary) return truncate(summary, maxLength);
    return truncate(`${entry.subtype} · tokens ${entry.inputTokens}/${entry.outputTokens} · $${Number(entry.costUsd || 0).toFixed(2)}`, maxLength);
  }
  if (entry.kind === "init") {
    return truncate(`${entry.model} · ${entry.sessionId}`, maxLength);
  }
  if ("text" in entry) {
    return truncate(firstMeaningfulLine(entry.text || "") || entry.text || "", maxLength);
  }
  return "";
}

function isTurnScopedEntry(entry: TranscriptEntry) {
  return entry.kind === "assistant"
    || entry.kind === "thinking"
    || entry.kind === "tool_call"
    || entry.kind === "tool_result"
    || entry.kind === "result";
}

function isErrorTranscriptEntry(entry: TranscriptEntry) {
  return entry.kind === "stderr"
    || (entry.kind === "tool_result" && entry.isError)
    || (entry.kind === "result" && entry.isError);
}

export function buildObservedRunTrace(detailOrEntries: ObservedRunDetail | TranscriptEntry[]): ObservedRunTrace {
  const entries = Array.isArray(detailOrEntries) ? detailOrEntries : detailOrEntries.transcript;
  const steps: ObservedRunStep[] = [];
  const looseSteps: ObservedRunStep[] = [];
  const turns = new Map<number, ObservedRunTurn>();

  let nextTurnIndex = 0;
  let activeTurn: number | null = null;

  for (const [rawIndex, entry] of entries.entries()) {
    let turnIndex: number | null = null;
    if (entry.kind === "assistant" || entry.kind === "thinking") {
      if (activeTurn === null) activeTurn = ++nextTurnIndex;
      turnIndex = activeTurn;
    } else if (entry.kind === "tool_call" || entry.kind === "tool_result" || entry.kind === "result") {
      if (activeTurn === null) activeTurn = ++nextTurnIndex;
      turnIndex = activeTurn;
      if (entry.kind === "result") activeTurn = null;
    }

    const detailText = detailTextForTranscriptEntry(entry);
    const preview = previewTextForTranscriptEntry(entry);
    const detailPreview = truncate(firstMeaningfulLine(detailText) || preview || "(empty)", 220);
    const step: ObservedRunStep = {
      index: rawIndex + 1,
      turnIndex,
      kind: entry.kind,
      ts: entry.ts,
      label: turnIndex ? `Turn ${turnIndex}` : `Step ${rawIndex + 1}`,
      preview,
      detailPreview,
      detailText,
      isModelEntry: isModelTranscriptEntry(entry),
      isPayloadEntry: isPayloadTranscriptEntry(entry),
      hasExpandableDetail: Boolean(detailText && detailText.trim() && detailText.trim() !== preview.trim()),
      isError: isErrorTranscriptEntry(entry),
    };
    steps.push(step);

    if (!isTurnScopedEntry(entry) || turnIndex === null) {
      looseSteps.push(step);
      continue;
    }

    const turn = turns.get(turnIndex) ?? {
      turnIndex,
      label: `Turn ${turnIndex}`,
      summary: "",
      startedAt: step.ts,
      endedAt: step.ts,
      stepCount: 0,
      toolCallCount: 0,
      hasError: false,
      steps: [],
    };
    turn.steps.push(step);
    turn.stepCount += 1;
    turn.endedAt = step.ts;
    if (!turn.summary && step.preview) {
      turn.summary = step.preview;
    }
    if (step.kind === "tool_call") {
      turn.toolCallCount += 1;
    }
    if (step.isError) {
      turn.hasError = true;
    }
    turns.set(turnIndex, turn);
  }

  const orderedTurns = [...turns.values()].map((turn) => {
    const headline = turn.steps.find((step) => step.isModelEntry && step.preview)
      ?? turn.steps.find((step) => step.preview)
      ?? null;
    return {
      ...turn,
      summary: headline?.preview || "No transcript summary",
    };
  });

  return {
    steps,
    looseSteps,
    turns: orderedTurns,
    turnCount: orderedTurns.length,
    payloadStepCount: steps.filter((step) => step.isPayloadEntry).length,
  };
}

import type { LangfuseObservation } from "@langfuse/tracing";
import type { TranscriptEntry, UsageSummary } from "@rudderhq/agent-runtime-utils";
import type { ExecutionObservabilityContext } from "@rudderhq/shared";
import { startExecutionChildObservation, updateExecutionObservation } from "./langfuse.js";

interface TranscriptFallbackResult {
  ts?: string | null;
  model?: string | null;
  output?: string | null;
  usage?: UsageSummary | null;
  costUsd?: number | null;
  subtype?: string | null;
  isError?: boolean;
  errors?: string[];
}

interface EmitExecutionTranscriptTreeInput {
  context: ExecutionObservabilityContext;
  parentObservation: LangfuseObservation | null;
  transcript: TranscriptEntry[];
  fallbackResult?: TranscriptFallbackResult | null;
}

interface ActiveTurnState {
  index: number;
  observation: LangfuseObservation | null;
  assistantText: string;
  thinkingText: string;
  startedAt: string;
  lastTs: string;
  toolCallCount: number;
  hasError: boolean;
  model: string | null;
  sessionId: string | null;
  pendingToolKeys: Set<string>;
}

interface PendingToolState {
  observation: LangfuseObservation | null;
  turnIndex: number;
  name: string | null;
}

export interface ExecutionTranscriptTreeStats {
  turnCount: number;
  toolCount: number;
  eventCount: number;
  finalOutput: string | null;
  finalModel: string | null;
  finalUsage: UsageSummary | null;
  finalSessionId: string | null;
  hasError: boolean;
}

function parseTs(value: string | null | undefined) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function appendTranscriptText(current: string, next: string, isDelta = false) {
  if (!next) return current;
  if (isDelta) return current + next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next) || current.includes(next)) return current;
  return current + next;
}

function usageDetailsFromTokens(inputTokens: number, outputTokens: number) {
  return {
    input: inputTokens,
    output: outputTokens,
  };
}

function normalizeToolKey(entry: { toolUseId?: string | null; name?: string | null }, fallbackIndex: number) {
  return entry.toolUseId?.trim() || entry.name?.trim() || `tool:${fallbackIndex}`;
}

function createTranscriptEvent(
  parentObservation: LangfuseObservation,
  context: ExecutionObservabilityContext,
  input: {
    name: string;
    ts: string;
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
    output: string;
    metadata?: Record<string, unknown>;
  },
) {
  const eventObservation = startExecutionChildObservation(parentObservation, context, {
    name: input.name,
    asType: "event",
    startTime: parseTs(input.ts),
    level: input.level,
    output: input.output,
    metadata: input.metadata,
  });
  eventObservation?.end(parseTs(input.ts));
}

export function emitExecutionTranscriptTree(
  input: EmitExecutionTranscriptTreeInput,
): ExecutionTranscriptTreeStats {
  if (!input.parentObservation || input.transcript.length === 0) {
    return {
      turnCount: 0,
      toolCount: 0,
      eventCount: 0,
      finalOutput: null,
      finalModel: null,
      finalUsage: null,
      finalSessionId: null,
      hasError: false,
    };
  }

  let turnCount = 0;
  let toolCount = 0;
  let eventCount = 0;
  let fallbackToolIndex = 0;
  let pendingModel = input.fallbackResult?.model ?? null;
  let pendingSessionId: string | null = input.context.sessionKey ?? null;
  let finalOutput: string | null = null;
  let finalModel: string | null = pendingModel ?? null;
  let finalUsage: UsageSummary | null = null;
  let finalSessionId: string | null = pendingSessionId ?? null;
  let finalHasError = false;
  let activeTurn: ActiveTurnState | null = null;
  const pendingTools = new Map<string, PendingToolState>();

  const closeTool = (
    key: string,
    ts: string,
    inputData: {
      output: string;
      isError: boolean;
      toolName?: string | null;
      statusMessage?: string;
    },
  ) => {
    const tool = pendingTools.get(key);
    if (!tool) return;

    updateExecutionObservation(tool.observation, input.context, {
      output: inputData.output,
      level: inputData.isError ? "ERROR" : "DEFAULT",
      statusMessage: inputData.statusMessage ?? (inputData.isError ? "tool_error" : "tool_completed"),
      metadata: {
        turnIndex: tool.turnIndex,
        toolUseId: key,
        toolName: inputData.toolName ?? tool.name,
        isError: inputData.isError,
      },
    });
    tool.observation?.end(parseTs(ts));
    pendingTools.delete(key);
    if (activeTurn) {
      activeTurn.pendingToolKeys.delete(key);
      if (inputData.isError) activeTurn.hasError = true;
    }
  };

  const ensureTurn = (ts: string) => {
    if (activeTurn) {
      activeTurn.lastTs = ts;
      return activeTurn;
    }

    turnCount += 1;
    const turnObservation = startExecutionChildObservation(input.parentObservation, input.context, {
      name: `model_turn:${turnCount}`,
      asType: "generation",
      startTime: parseTs(ts),
      model: pendingModel ?? undefined,
      metadata: {
        turnIndex: turnCount,
        sessionId: pendingSessionId,
      },
    });

    activeTurn = {
      index: turnCount,
      observation: turnObservation,
      assistantText: "",
      thinkingText: "",
      startedAt: ts,
      lastTs: ts,
      toolCallCount: 0,
      hasError: false,
      model: pendingModel,
      sessionId: pendingSessionId,
      pendingToolKeys: new Set<string>(),
    };
    return activeTurn;
  };

  const finalizeTurn = (
    turn: ActiveTurnState,
    ts: string,
    result: TranscriptFallbackResult | null = null,
  ) => {
    for (const toolKey of [...turn.pendingToolKeys]) {
      closeTool(toolKey, ts, {
        output: "Tool result missing before turn completion",
        isError: true,
        statusMessage: "tool_result_missing",
      });
    }

    const output = result?.output?.trim() || turn.assistantText.trim() || null;
    const errors = result?.errors?.length ? result.errors : null;
    const usage = result?.usage
      ? {
        ...usageDetailsFromTokens(result.usage.inputTokens, result.usage.outputTokens),
        ...(typeof result.usage.cachedInputTokens === "number" && result.usage.cachedInputTokens > 0
          ? { cachedInput: result.usage.cachedInputTokens }
          : {}),
      }
      : null;
    const costUsd = typeof result?.costUsd === "number" && Number.isFinite(result.costUsd)
      ? result.costUsd
      : null;
    const hasError = turn.hasError || result?.isError === true || Boolean(errors?.length);

    updateExecutionObservation(turn.observation, input.context, {
      output,
      model: turn.model ?? result?.model ?? undefined,
      usageDetails: usage ?? undefined,
      costDetails: costUsd !== null ? { totalCost: costUsd } : undefined,
      level: hasError ? "ERROR" : "DEFAULT",
      statusMessage: result?.subtype ?? (hasError ? "generation_failed" : "generation_completed"),
      metadata: {
        turnIndex: turn.index,
        assistantText: output,
        thinkingText: turn.thinkingText.trim() || null,
        toolCallCount: turn.toolCallCount,
        hasError,
        sessionId: turn.sessionId,
        errors,
      },
    });
    turn.observation?.end(parseTs(ts));
    finalOutput = output;
    finalModel = turn.model ?? result?.model ?? finalModel;
    finalUsage = result?.usage ?? finalUsage;
    finalHasError = hasError;
    activeTurn = null;
  };

  for (const entry of input.transcript) {
    switch (entry.kind) {
      case "init": {
        pendingModel = entry.model;
        pendingSessionId = entry.sessionId;
        finalSessionId = entry.sessionId;
        const turn = activeTurn as ActiveTurnState | null;
        if (turn) {
          turn.model = entry.model;
          turn.sessionId = entry.sessionId;
        }
        createTranscriptEvent(input.parentObservation, input.context, {
          name: "runtime.init",
          ts: entry.ts,
          output: `model=${entry.model}\nsession=${entry.sessionId}`,
          metadata: {
            model: entry.model,
            sessionId: entry.sessionId,
          },
        });
        eventCount += 1;
        break;
      }

      case "assistant": {
        const turn = ensureTurn(entry.ts);
        turn.assistantText = appendTranscriptText(turn.assistantText, entry.text, entry.delta === true);
        turn.lastTs = entry.ts;
        break;
      }

      case "thinking": {
        const turn = ensureTurn(entry.ts);
        turn.thinkingText = appendTranscriptText(turn.thinkingText, entry.text, entry.delta === true);
        turn.lastTs = entry.ts;
        break;
      }

      case "tool_call": {
        const turn = ensureTurn(entry.ts);
        const toolKey = normalizeToolKey(entry, ++fallbackToolIndex);
        if (pendingTools.has(toolKey)) {
          closeTool(toolKey, entry.ts, {
            output: "Tool call restarted before receiving a result",
            isError: true,
            toolName: entry.name,
            statusMessage: "tool_restarted",
          });
        }
        const toolObservation = startExecutionChildObservation(turn.observation, input.context, {
          name: entry.name,
          asType: "tool",
          startTime: parseTs(entry.ts),
          input: entry.input,
          metadata: {
            turnIndex: turn.index,
            toolUseId: toolKey,
            toolName: entry.name,
          },
        });
        pendingTools.set(toolKey, {
          observation: toolObservation,
          turnIndex: turn.index,
          name: entry.name,
        });
        turn.pendingToolKeys.add(toolKey);
        turn.toolCallCount += 1;
        turn.lastTs = entry.ts;
        toolCount += 1;
        break;
      }

      case "tool_result": {
        const turn = ensureTurn(entry.ts);
        const toolKey = normalizeToolKey(entry, ++fallbackToolIndex);
        if (!pendingTools.has(toolKey)) {
          const fallbackToolObservation = startExecutionChildObservation(turn.observation, input.context, {
            name: entry.toolName ?? "tool_result",
            asType: "tool",
            startTime: parseTs(entry.ts),
            metadata: {
              turnIndex: turn.index,
              toolUseId: toolKey,
              toolName: entry.toolName ?? null,
              synthetic: true,
            },
          });
          pendingTools.set(toolKey, {
            observation: fallbackToolObservation,
            turnIndex: turn.index,
            name: entry.toolName ?? null,
          });
          turn.pendingToolKeys.add(toolKey);
          toolCount += 1;
        }
        closeTool(toolKey, entry.ts, {
          output: entry.content,
          isError: entry.isError,
          toolName: entry.toolName ?? null,
        });
        turn.lastTs = entry.ts;
        break;
      }

      case "result": {
        const turn = ensureTurn(entry.ts);
        finalizeTurn(turn, entry.ts, {
          ts: entry.ts,
          output: entry.text,
          model: turn.model ?? pendingModel,
          usage: {
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            cachedInputTokens: entry.cachedTokens,
          },
          costUsd: entry.costUsd,
          subtype: entry.subtype,
          isError: entry.isError,
          errors: entry.errors,
        });
        break;
      }

      case "stderr": {
        createTranscriptEvent(input.parentObservation, input.context, {
          name: "stderr",
          ts: entry.ts,
          level: "ERROR",
          output: entry.text,
        });
        eventCount += 1;
        const turn = activeTurn as ActiveTurnState | null;
        if (turn) turn.hasError = true;
        break;
      }

      case "stdout": {
        createTranscriptEvent(input.parentObservation, input.context, {
          name: "stdout",
          ts: entry.ts,
          level: "DEBUG",
          output: entry.text,
        });
        eventCount += 1;
        break;
      }

      case "system": {
        createTranscriptEvent(input.parentObservation, input.context, {
          name: "system",
          ts: entry.ts,
          output: entry.text,
        });
        eventCount += 1;
        break;
      }

      case "user":
        break;
    }
  }

  const finalTurn = activeTurn as ActiveTurnState | null;
  if (finalTurn) {
    finalizeTurn(
      finalTurn,
      input.fallbackResult?.ts ?? finalTurn.lastTs,
      input.fallbackResult ?? null,
    );
  }

  updateExecutionObservation(input.parentObservation, input.context, {
    metadata: {
      transcriptEntryCount: input.transcript.length,
      transcriptTurnCount: turnCount,
      transcriptToolCount: toolCount,
      transcriptEventCount: eventCount,
    },
  });

  return {
    turnCount,
    toolCount,
    eventCount,
    finalOutput,
    finalModel,
    finalUsage,
    finalSessionId,
    hasError: finalHasError,
  };
}

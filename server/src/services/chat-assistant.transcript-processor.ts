import type { CursorAcpTranscriptEvent, TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import {
  createRudderInlineVisualStreamSuppressor,
  redactRudderInlineVisualSources,
} from "@rudderhq/shared";
import {
  createAssistantTextAccumulator,
  createSentinelStream,
  maybeEmitAssistantState,
  parseAssistantTextBlock,
  partialBodyFromRawAssistantText,
  shouldSuppressChatTranscriptEntry,
  type ChatTranscriptDelivery,
  type StreamChatAssistantReplyInput,
} from "./chat-assistant.helpers.js";

type TranscriptProcessingState = {
  hasNativeFinalMessage: boolean;
  hasRuntimeOutputEvidence: boolean;
};

export function createChatAssistantTranscriptProcessor(input: {
  callbacks: Pick<
    StreamChatAssistantReplyInput,
    "onAssistantState" | "onObservedTranscriptEntry" | "onTranscriptEntry"
  >;
  isInactive: () => boolean;
  appendTranscriptEntry: (entry: TranscriptEntry, delivery: ChatTranscriptDelivery) => Promise<unknown>;
  resultSentinel: string;
  transcriptDelivery: ChatTranscriptDelivery;
  assistantTextAccumulator: ReturnType<typeof createAssistantTextAccumulator>;
  finalAssistantTextAccumulator: ReturnType<typeof createAssistantTextAccumulator>;
  sentinelStream: ReturnType<typeof createSentinelStream>;
  inlineVisualStream: ReturnType<typeof createRudderInlineVisualStreamSuppressor>;
  commentaryInlineVisualStream: ReturnType<typeof createRudderInlineVisualStreamSuppressor>;
  durableTranscriptImages: ReadonlyMap<string, { contentPath: string; displayName: string }>;
  state: TranscriptProcessingState;
}) {
  const transcriptInlineVisualStream = createRudderInlineVisualStreamSuppressor();
  let transcriptDeltaOpen = false;
  let transcriptDeltaCarry = "";

  const processTranscriptEntries = async (entries: TranscriptEntry[]) => {
    for (const entry of entries) {
      if (input.isInactive()) return;
      if (entry.kind !== "init") input.state.hasRuntimeOutputEvidence = true;
      if (entry.kind === "tool_call") {
        await maybeEmitAssistantState(input.callbacks.onAssistantState, "tool_busy");
        if (input.isInactive()) return;
      }
      if (entry.kind === "assistant") {
        if (entry.phase === "commentary") {
          // Streaming deltas may begin or end with meaningful whitespace.
          // Keep one suppressor for the whole commentary stream so private
          // inline visuals stay filtered without trimming token boundaries.
          const commentaryText = entry.delta === true
            ? input.commentaryInlineVisualStream.push(entry.text)
            : redactRudderInlineVisualSources(entry.text);
          if (!commentaryText) continue;
          const commentaryEntry: TranscriptEntry = {
            kind: "assistant",
            ts: entry.ts,
            text: commentaryText,
            ...(entry.delta === true ? { delta: true } : {}),
            phase: "commentary",
            ...(entry.segmentId ? { segmentId: entry.segmentId } : {}),
          };
          await input.callbacks.onObservedTranscriptEntry?.(commentaryEntry, input.transcriptDelivery);
          if (input.isInactive()) return;
          await input.callbacks.onTranscriptEntry?.(commentaryEntry, input.transcriptDelivery);
          if (input.isInactive()) return;
          await input.appendTranscriptEntry(commentaryEntry, input.transcriptDelivery);
          continue;
        }
        if (entry.phase === "final_answer") {
          input.state.hasNativeFinalMessage = true;
        }
        const delta = input.assistantTextAccumulator.push(entry.text, entry.delta === true);
        if (entry.phase === "final_answer") {
          input.finalAssistantTextAccumulator.push(entry.text, entry.delta === true);
        }
        if (!delta) continue;
        const visibleDelta = input.inlineVisualStream.push(input.sentinelStream.push(delta));
        const textBlock = parseAssistantTextBlock(input.assistantTextAccumulator.fullText);
        if (visibleDelta && !textBlock) {
          const assistantTranscriptEntry: TranscriptEntry = {
            kind: "assistant",
            ts: entry.ts,
            text: visibleDelta,
            delta: true,
            ...(entry.phase === "final_answer" ? { phase: "final_answer" } : {}),
            ...(entry.segmentId ? { segmentId: entry.segmentId } : {}),
          };
          await input.callbacks.onObservedTranscriptEntry?.(assistantTranscriptEntry, input.transcriptDelivery);
          if (input.isInactive()) return;
          await input.callbacks.onTranscriptEntry?.(assistantTranscriptEntry, input.transcriptDelivery);
          if (input.isInactive()) return;
          await input.appendTranscriptEntry(assistantTranscriptEntry, input.transcriptDelivery);
        }
        continue;
      }
      const suppressTranscriptSource = (text: string, delta = false) => {
        const hideResidualWidgetSource = (output: string) => (
          /<div\b[^>]*\bid\s*=\s*["']widget["']/i.test(output)
            ? `[private inline visual source omitted]${output.endsWith("\n") ? "\n" : ""}`
            : output
        );
        if (delta) {
          // Thinking deltas are arbitrary stream fragments. Preserve continuity
          // and admit only complete logical lines so raw widget markup cannot be
          // projected before an opening marker or tag finishes across chunks.
          transcriptDeltaOpen = true;
          transcriptDeltaCarry += text;
          if (Buffer.byteLength(transcriptDeltaCarry, "utf8") > 256 * 1024) {
            transcriptDeltaCarry = "";
            transcriptDeltaOpen = false;
            return "[oversized transcript delta omitted]";
          }
          let output = "";
          let newline = transcriptDeltaCarry.indexOf("\n");
          while (newline >= 0) {
            output += hideResidualWidgetSource(
              transcriptInlineVisualStream.push(transcriptDeltaCarry.slice(0, newline + 1)),
            );
            transcriptDeltaCarry = transcriptDeltaCarry.slice(newline + 1);
            newline = transcriptDeltaCarry.indexOf("\n");
          }
          return output;
        }
        // Complete transcript entries are logical records. The synthetic newline
        // lets own-line markers advance the shared state machine when a runtime
        // reports START/body/END as separate non-delta entries.
        let output = "";
        if (transcriptDeltaOpen) {
          if (transcriptDeltaCarry) {
            output += hideResidualWidgetSource(
              transcriptInlineVisualStream.push(`${transcriptDeltaCarry}\n`),
            );
            transcriptDeltaCarry = "";
          }
          transcriptDeltaOpen = false;
        }
        const admittedRecord = transcriptInlineVisualStream.push(`${text}\n`);
        const recordOutput = admittedRecord.endsWith("\n")
          ? admittedRecord.slice(0, -1)
          : admittedRecord;
        return output + hideResidualWidgetSource(recordOutput);
      };
      let structuredTranscriptNodes = 0;
      let structuredTranscriptBytes = 0;
      const suppressStructuredTranscriptValue = (value: unknown, depth = 0): unknown => {
        structuredTranscriptNodes += 1;
        if (structuredTranscriptNodes > 1_000) return "[bounded transcript value omitted]";
        if (typeof value === "string") {
          structuredTranscriptBytes += Buffer.byteLength(value, "utf8");
          if (structuredTranscriptBytes > 256 * 1024) return "[bounded transcript value omitted]";
          return suppressTranscriptSource(value);
        }
        if (depth >= 8) return "[bounded transcript value omitted]";
        if (Array.isArray(value)) {
          return value.slice(0, 100).map((item) => suppressStructuredTranscriptValue(item, depth + 1));
        }
        if (value && typeof value === "object") {
          const output: Record<string, unknown> = {};
          for (const [index, [key, item]] of Object.entries(value as Record<string, unknown>)
            .slice(0, 100)
            .entries()) {
            structuredTranscriptBytes += Buffer.byteLength(key, "utf8");
            const sanitizedKey = structuredTranscriptBytes > 256 * 1024
              ? `[bounded-key-${index}]`
              : suppressTranscriptSource(key) || `[redacted-key-${index}]`;
            let uniqueKey = sanitizedKey;
            let suffix = 1;
            while (Object.hasOwn(output, uniqueKey)) {
              uniqueKey = `${sanitizedKey}-${suffix}`;
              suffix += 1;
            }
            output[uniqueKey] = suppressStructuredTranscriptValue(item, depth + 1);
          }
          return output;
        }
        return value;
      };
      const safeEntry: TranscriptEntry = (() => {
        switch (entry.kind) {
          case "thinking":
            return {
              kind: entry.kind,
              ts: entry.ts,
              text: suppressTranscriptSource(entry.text, entry.delta === true),
              ...(entry.delta === true ? { delta: true } : {}),
              ...(entry.segmentId ? { segmentId: suppressTranscriptSource(entry.segmentId) } : {}),
            };
          case "user":
          case "stderr":
          case "system":
          case "stdout":
            return {
              kind: entry.kind,
              ts: entry.ts,
              text: suppressTranscriptSource(entry.text),
            };
          case "result":
            return {
              kind: entry.kind,
              ts: entry.ts,
              text: suppressTranscriptSource(entry.text),
              inputTokens: entry.inputTokens,
              outputTokens: entry.outputTokens,
              cachedTokens: entry.cachedTokens,
              costUsd: entry.costUsd,
              subtype: suppressTranscriptSource(entry.subtype),
              isError: entry.isError,
              errors: entry.errors.slice(0, 100).map((message) => suppressTranscriptSource(message)),
            };
          case "tool_result":
            return {
              kind: entry.kind,
              ts: entry.ts,
              content: suppressTranscriptSource(entry.content),
              ...(entry.toolName ? { toolName: suppressTranscriptSource(entry.toolName) } : {}),
              toolUseId: suppressTranscriptSource(entry.toolUseId),
              isError: entry.isError,
            };
          case "tool_call":
            {
              const rawInput = entry.input && typeof entry.input === "object" && !Array.isArray(entry.input)
                ? entry.input as Record<string, unknown>
                : null;
              const normalizedToolName = entry.name.trim().toLowerCase().replace(/[\s_-]+/g, "");
              const durableImage = normalizedToolName === "imageview" && typeof rawInput?.path === "string"
                ? input.durableTranscriptImages.get(rawInput.path)
                : null;
              const durableInput = durableImage && rawInput
                ? {
                  ...rawInput,
                  path: durableImage.contentPath,
                  displayName: durableImage.displayName,
                }
                : entry.input;
              return {
                kind: entry.kind,
                ts: entry.ts,
                name: suppressTranscriptSource(entry.name),
                input: suppressStructuredTranscriptValue(durableInput),
                ...(entry.toolUseId ? { toolUseId: suppressTranscriptSource(entry.toolUseId) } : {}),
              };
            }
          case "todo_list":
            return {
              kind: entry.kind,
              ts: entry.ts,
              ...(entry.todoListId ? { todoListId: suppressTranscriptSource(entry.todoListId) } : {}),
              items: entry.items.slice(0, 100).map((item) => ({
                text: suppressTranscriptSource(item.text),
                status: item.status,
              })),
            };
          case "init":
            return {
              kind: entry.kind,
              ts: entry.ts,
              model: suppressTranscriptSource(entry.model),
              sessionId: suppressTranscriptSource(entry.sessionId),
            };
          default:
            return {
              kind: "system",
              ts: new Date().toISOString(),
              text: "Unsupported runtime transcript entry omitted",
            };
        }
      })();
      const cursorAcpEvent = "cursorAcpEvent" in entry ? entry.cursorAcpEvent : undefined;
      const safeCursorAcpEvent: CursorAcpTranscriptEvent | undefined = cursorAcpEvent
        ? {
            provider: cursorAcpEvent.provider,
            transport: cursorAcpEvent.transport,
            method: suppressTranscriptSource(cursorAcpEvent.method),
            ...(cursorAcpEvent.sessionId
              ? { sessionId: suppressTranscriptSource(cursorAcpEvent.sessionId) }
              : {}),
            ...(cursorAcpEvent.updateKind
              ? { updateKind: suppressTranscriptSource(cursorAcpEvent.updateKind) }
              : {}),
            ...(typeof cursorAcpEvent.requestId === "string"
              ? { requestId: suppressTranscriptSource(cursorAcpEvent.requestId) }
              : typeof cursorAcpEvent.requestId === "number"
                ? { requestId: cursorAcpEvent.requestId }
                : {}),
            frame: (() => {
              const frame = suppressStructuredTranscriptValue(cursorAcpEvent.frame);
              return frame && typeof frame === "object" && !Array.isArray(frame)
                ? frame as Record<string, unknown>
                : {};
            })(),
          }
        : undefined;
      const transcriptEntry: TranscriptEntry = safeCursorAcpEvent
        ? { ...safeEntry, cursorAcpEvent: safeCursorAcpEvent } as TranscriptEntry
        : safeEntry;
      if (entry.kind === "result") {
        const safeResultEntry = transcriptEntry.kind === "result" ? transcriptEntry : null;
        const observedText = partialBodyFromRawAssistantText(safeResultEntry?.text ?? "", input.resultSentinel);
        if (observedText) {
          await input.callbacks.onObservedTranscriptEntry?.({
            ...safeResultEntry!,
            text: observedText,
          }, input.transcriptDelivery);
        }
      } else if (
        !(entry.kind === "stdout" && entry.text.includes(input.resultSentinel))
        && !(
          ("text" in safeEntry && typeof safeEntry.text === "string" && safeEntry.text.length === 0)
          || (safeEntry.kind === "tool_result" && safeEntry.content.length === 0)
        )
      ) {
        await input.callbacks.onObservedTranscriptEntry?.(transcriptEntry, input.transcriptDelivery);
      }
      if (input.isInactive()) return;
      const suppressVisibleEntry = shouldSuppressChatTranscriptEntry(entry, input.resultSentinel)
        || (
        ("text" in transcriptEntry && typeof transcriptEntry.text === "string" && transcriptEntry.text.length === 0)
        || (transcriptEntry.kind === "tool_result" && transcriptEntry.content.length === 0)
        );
      if (!suppressVisibleEntry) {
        await input.callbacks.onTranscriptEntry?.(transcriptEntry, input.transcriptDelivery);
        if (input.isInactive()) return;
        await input.appendTranscriptEntry(transcriptEntry, input.transcriptDelivery);
      }
      if (entry.kind === "tool_result") {
        await maybeEmitAssistantState(input.callbacks.onAssistantState, "streaming");
        if (input.isInactive()) return;
      }
    }
  };

  return { processTranscriptEntries };
}

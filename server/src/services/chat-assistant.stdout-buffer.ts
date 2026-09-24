import { ChatAssistantStreamError } from "./chat-assistant.contracts.js";

export const MAX_CHAT_ASSISTANT_STDOUT_LINE_BYTES = 8 * 1024 * 1024;

const oversizedLineMessage = `Chat runtime stdout line exceeded ${MAX_CHAT_ASSISTANT_STDOUT_LINE_BYTES} bytes`;
const oversizedLineUserMessage =
  "The assistant produced an output event that was too large to process safely. Rudder stopped the reply instead of truncating it; retry with smaller tool output.";

export function createChatAssistantStdoutBuffer(input: {
  isInactive: () => boolean;
  processLine: (line: string) => Promise<void>;
}) {
  let pending = "";

  const failOversizedLine = (): never => {
    pending = "";
    throw new ChatAssistantStreamError(oversizedLineMessage, "", [], {
      errorCode: "chat_runtime_exception",
      userMessage: oversizedLineUserMessage,
    });
  };

  const appendPart = (chunk: string, start: number, end: number) => {
    const partLength = end - start;
    if (pending.length + partLength > MAX_CHAT_ASSISTANT_STDOUT_LINE_BYTES) {
      failOversizedLine();
    }
    const candidate = pending + chunk.slice(start, end);
    if (Buffer.byteLength(candidate, "utf8") > MAX_CHAT_ASSISTANT_STDOUT_LINE_BYTES) {
      failOversizedLine();
    }
    pending = candidate;
  };

  const flushChunk = async (chunk: string, finalize = false) => {
    if (input.isInactive()) return;
    let offset = 0;
    while (offset < chunk.length) {
      if (input.isInactive()) return;
      const newlineIndex = chunk.indexOf("\n", offset);
      const lineEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
      appendPart(chunk, offset, lineEnd);
      if (newlineIndex === -1) break;

      const line = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
      pending = "";
      if (input.isInactive()) return;
      await input.processLine(line);
      offset = newlineIndex + 1;
    }
    if (!input.isInactive() && finalize && pending.trim()) {
      const trailing = pending;
      pending = "";
      await input.processLine(trailing);
    }
  };

  return {
    append: (chunk: string) => flushChunk(chunk),
    flush: () => flushChunk("", true),
  };
}

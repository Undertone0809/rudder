import { redactRudderInlineVisualSources } from "@rudderhq/shared";
import {
  extractRudderInlineVisualArtifacts,
  type ChatAssistantResult,
} from "./chat-assistant.helpers.js";

export function normalizeReplyInlineVisuals(
  reply: Pick<ChatAssistantResult, "kind" | "body">,
  reservedSlots: number,
) {
  return reply.kind === "message"
    ? extractRudderInlineVisualArtifacts(reply.body, { reservedSlots })
    : {
      body: redactRudderInlineVisualSources(reply.body),
      attachments: [],
      inlineVisualsV1: [],
    };
}

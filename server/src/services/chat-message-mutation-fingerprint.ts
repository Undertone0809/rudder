import type { ChatInlineAnnotationInput, ChatMessage } from "@rudderhq/shared";
import { createHash } from "node:crypto";
import { conflict } from "../errors.js";

type MutationFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size?: number;
};

export function chatMessageMutationFingerprint(input: {
  body: string;
  editUserMessageId?: string | null;
  inlineAnnotationsProvided: boolean;
  inlineAnnotations?: ChatInlineAnnotationInput[];
  modelOverride?: string | null;
  effortOverride?: string | null;
  files: readonly MutationFile[];
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      body: input.body,
      editUserMessageId: input.editUserMessageId ?? null,
      inlineAnnotations: input.inlineAnnotationsProvided
        ? (input.inlineAnnotations ?? [])
        : null,
      modelOverride: input.modelOverride ?? null,
      effortOverride: input.effortOverride ?? null,
      files: input.files.map((file, index) => ({
        index,
        contentType: file.mimetype.toLowerCase(),
        byteSize: file.size ?? file.buffer.byteLength,
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
        originalFilename: file.originalname || null,
      })),
    }))
    .digest("hex");
}

export async function replayChatMessageMutation(
  lookup: (orgId: string, conversationId: string, clientMutationId: string) => Promise<{
    message: ChatMessage;
    fingerprint: string | null;
  } | null>,
  input: {
    orgId: string;
    conversationId: string;
    clientMutationId?: string | null;
    body: string;
    fingerprint?: string | null;
  },
) {
  if (!input.clientMutationId) return null;
  const replayedMutation = await lookup(input.orgId, input.conversationId, input.clientMutationId);
  if (!replayedMutation) return null;
  if (
    replayedMutation.message.body !== input.body
    || (
      replayedMutation.fingerprint !== null
      && replayedMutation.fingerprint !== (input.fingerprint ?? null)
    )
  ) {
    throw conflict("Chat mutation key was already used for different content");
  }
  return replayedMutation.message;
}

export async function replayChatStreamMessage(input: {
  atomicFirstTurn: boolean;
  clientMutationId: string | null;
  body: string;
  editUserMessageId?: string | null;
  inlineAnnotationsProvided: boolean;
  inlineAnnotations?: ChatInlineAnnotationInput[];
  modelOverride?: string | null;
  effortOverride?: string | null;
  files: readonly MutationFile[];
  orgId: string;
  conversationId: string;
  lookup: Parameters<typeof replayChatMessageMutation>[0];
  response: any;
  writeStreamEvent: (response: any, event: any) => void;
}) {
  const fingerprint = input.clientMutationId
    ? chatMessageMutationFingerprint({
      body: input.body,
      editUserMessageId: input.editUserMessageId ?? null,
      inlineAnnotationsProvided: input.inlineAnnotationsProvided,
      inlineAnnotations: input.inlineAnnotations,
      modelOverride: input.modelOverride ?? null,
      effortOverride: input.effortOverride ?? null,
      files: input.files,
    })
    : null;
  if (input.atomicFirstTurn || !input.clientMutationId) return fingerprint;
  const replayedUserMessage = await replayChatMessageMutation(input.lookup, {
    orgId: input.orgId,
    conversationId: input.conversationId,
    clientMutationId: input.clientMutationId,
    body: input.body,
    fingerprint,
  });
  if (!replayedUserMessage) return fingerprint;
  input.response.status(200);
  input.response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  input.response.setHeader("Cache-Control", "no-cache, no-transform");
  input.response.setHeader("X-Accel-Buffering", "no");
  input.writeStreamEvent(input.response, { type: "ack", userMessage: replayedUserMessage });
  input.writeStreamEvent(input.response, { type: "final", messages: [] });
  input.response.end();
  return undefined;
}

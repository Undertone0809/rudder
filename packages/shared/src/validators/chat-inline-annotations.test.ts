import { describe, expect, it } from "vitest";
import {
  addChatMessageSchema,
  chatInlineAnnotationInputSchema,
  chatInlineAnnotationSchema,
  chatInlineAnnotationsFromStructuredPayload,
  chatInlineAnnotationsInputSchema,
  chatInlineAnnotationsSchema,
  createChatFirstTurnSchema,
  MAX_CHAT_INLINE_ANNOTATION_ATTACHMENTS,
  MAX_CHAT_INLINE_ANNOTATION_COMMENT_LENGTH,
  MAX_CHAT_INLINE_ANNOTATION_CONTEXT_LENGTH,
  MAX_CHAT_INLINE_ANNOTATION_SELECTED_TEXT_LENGTH,
  MAX_CHAT_INLINE_ANNOTATION_TOTAL_TEXT_LENGTH,
  MAX_CHAT_INLINE_ANNOTATIONS,
  normalizeChatInlineAnnotations,
  sanitizeChatStructuredPayload,
} from "../index.js";
import type { ChatInlineAnnotationInput } from "../types/chat.js";
import type { AddChatMessage, ChatQueuedMessagePayloadInput } from "./chat.js";
import { chatQueuedMessagePayloadSchema } from "./chat.js";

const sourceConversationId = "11111111-1111-4111-8111-111111111111";
const sourceMessageId = "22222222-2222-4222-8222-222222222222";

const annotationOnlyAddMessageInput: AddChatMessage = { inlineAnnotations: [] };
const annotationOnlyQueuedMessageInput: ChatQueuedMessagePayloadInput = { inlineAnnotations: [] };
void annotationOnlyAddMessageInput;
void annotationOnlyQueuedMessageInput;

function uuid(index: number) {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function assistantAnnotation(index = 1, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(index),
    selectedText: "Selected assistant text",
    comment: null,
    sourceConversationId,
    sourceMessageId,
    surface: "assistant_body",
    sourceHash: "a".repeat(64),
    start: 10,
    end: 33,
    prefix: "Before ",
    suffix: " after",
    attachmentIds: [],
    ...overrides,
  };
}

function processAnnotation(index = 1, overrides: Record<string, unknown> = {}) {
  return {
    ...assistantAnnotation(index),
    surface: "process_transcript",
    transcriptKind: "thinking",
    generationId: "33333333-3333-4333-8333-333333333333",
    generationSeqStart: 7,
    generationSeqEnd: 9,
    ...overrides,
  };
}

describe("chat inline annotation contracts", () => {
  it("exports the message limits", () => {
    expect({
      annotations: MAX_CHAT_INLINE_ANNOTATIONS,
      selectedText: MAX_CHAT_INLINE_ANNOTATION_SELECTED_TEXT_LENGTH,
      comment: MAX_CHAT_INLINE_ANNOTATION_COMMENT_LENGTH,
      totalText: MAX_CHAT_INLINE_ANNOTATION_TOTAL_TEXT_LENGTH,
      context: MAX_CHAT_INLINE_ANNOTATION_CONTEXT_LENGTH,
      attachments: MAX_CHAT_INLINE_ANNOTATION_ATTACHMENTS,
    }).toEqual({
      annotations: 10,
      selectedText: 4_000,
      comment: 2_000,
      totalText: 16_000,
      context: 160,
      attachments: 10,
    });
  });

  it("accepts annotation-only follow-ups and queued messages but keeps first-chat body required", () => {
    expect(addChatMessageSchema.safeParse({
      body: "   ",
      inlineAnnotations: [assistantAnnotation()],
    })).toMatchObject({ success: true, data: { body: "" } });
    expect(chatQueuedMessagePayloadSchema.safeParse({
      body: "",
      inlineAnnotations: [assistantAnnotation()],
    }).success).toBe(true);
    expect(addChatMessageSchema.safeParse({
      inlineAnnotations: [assistantAnnotation()],
    })).toMatchObject({ success: true, data: { body: "" } });
    expect(chatQueuedMessagePayloadSchema.safeParse({
      inlineAnnotations: [assistantAnnotation()],
    })).toMatchObject({ success: true, data: { body: "" } });

    expect(addChatMessageSchema.safeParse({ body: " " }).success).toBe(false);
    expect(chatQueuedMessagePayloadSchema.safeParse({ body: "" }).success).toBe(false);
    expect(createChatFirstTurnSchema.safeParse({
      body: "",
      inlineAnnotations: [assistantAnnotation()],
    }).success).toBe(false);
  });

  it("normalizes comments and strips request-only attachment file indexes", () => {
    const request = assistantAnnotation(1, {
      comment: "   ",
      attachmentIds: [uuid(101)],
      attachmentFileIndexes: [0, 2],
    });

    expect(chatInlineAnnotationInputSchema.parse(request)).toMatchObject({
      comment: null,
      attachmentFileIndexes: [0, 2],
    });
    const normalized = normalizeChatInlineAnnotations([request as ChatInlineAnnotationInput]);
    expect(normalized).toEqual([{
      ...assistantAnnotation(1),
      attachmentIds: [uuid(101)],
    }]);
    expect(chatInlineAnnotationSchema.safeParse(request).success).toBe(false);
  });

  it("enforces annotation, text, context, offset, and aggregate text limits", () => {
    expect(chatInlineAnnotationsInputSchema.safeParse(
      Array.from({ length: MAX_CHAT_INLINE_ANNOTATIONS + 1 }, (_, index) =>
        assistantAnnotation(index + 1)),
    ).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(assistantAnnotation(1, {
      selectedText: "x".repeat(MAX_CHAT_INLINE_ANNOTATION_SELECTED_TEXT_LENGTH + 1),
    })).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(assistantAnnotation(1, {
      selectedText: " ",
    })).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(assistantAnnotation(1, {
      sourceHash: "A".repeat(64),
    })).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(assistantAnnotation(1, {
      comment: ` ${"x".repeat(MAX_CHAT_INLINE_ANNOTATION_COMMENT_LENGTH + 1)} `,
    })).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(assistantAnnotation(1, {
      prefix: "x".repeat(MAX_CHAT_INLINE_ANNOTATION_CONTEXT_LENGTH + 1),
    })).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(assistantAnnotation(1, {
      start: 10,
      end: 10,
    })).success).toBe(false);
    expect(chatInlineAnnotationsInputSchema.safeParse(
      Array.from({ length: 5 }, (_, index) => assistantAnnotation(index + 1, {
        selectedText: "x".repeat(3_200),
        comment: index === 0 ? "x" : null,
      })),
    ).success).toBe(false);
  });

  it("requires unique attachment mappings within and across annotations", () => {
    expect(chatInlineAnnotationsInputSchema.safeParse([
      assistantAnnotation(1, { attachmentIds: [uuid(101)] }),
      assistantAnnotation(2, { attachmentIds: [uuid(101)] }),
    ]).success).toBe(false);
    expect(chatInlineAnnotationsInputSchema.safeParse([
      assistantAnnotation(1, { attachmentFileIndexes: [0] }),
      assistantAnnotation(2, { attachmentFileIndexes: [0] }),
    ]).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(assistantAnnotation(1, {
      attachmentIds: [uuid(101), uuid(101)],
    })).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(assistantAnnotation(1, {
      attachmentFileIndexes: [-1],
    })).success).toBe(false);
    expect(chatInlineAnnotationsInputSchema.safeParse([
      assistantAnnotation(1, {
        attachmentIds: Array.from(
          { length: MAX_CHAT_INLINE_ANNOTATION_ATTACHMENTS },
          (_, index) => uuid(100 + index),
        ),
      }),
      assistantAnnotation(2, { attachmentFileIndexes: [0] }),
    ]).success).toBe(false);
  });

  it("requires unique annotation identities across the message", () => {
    expect(chatInlineAnnotationsInputSchema.safeParse([
      assistantAnnotation(1),
      assistantAnnotation(1, { selectedText: "A second selection" }),
    ]).success).toBe(false);
  });

  it("requires complete process provenance and forbids it on assistant body annotations", () => {
    expect(chatInlineAnnotationInputSchema.safeParse(processAnnotation()).success).toBe(true);
    expect(chatInlineAnnotationInputSchema.safeParse(processAnnotation(1, {
      transcriptKind: undefined,
    })).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(processAnnotation(1, {
      generationId: undefined,
    })).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(processAnnotation(1, {
      generationSeqStart: 10,
      generationSeqEnd: 9,
    })).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(assistantAnnotation(1, {
      generationId: "33333333-3333-4333-8333-333333333333",
    })).success).toBe(false);
    expect(chatInlineAnnotationInputSchema.safeParse(assistantAnnotation(1, {
      transcriptKind: "assistant",
      generationSeqStart: 1,
      generationSeqEnd: 1,
    })).success).toBe(false);
  });
});

describe("chat inline annotation structured payloads", () => {
  it("extracts only a fully valid canonical annotation array", () => {
    const annotations = [
      assistantAnnotation(1),
      processAnnotation(2),
    ];
    expect(chatInlineAnnotationsSchema.parse(annotations)).toEqual(annotations);
    expect(chatInlineAnnotationsFromStructuredPayload({
      inlineAnnotations: annotations,
    })).toEqual(annotations);

    expect(chatInlineAnnotationsFromStructuredPayload({
      inlineAnnotations: [
        assistantAnnotation(1),
        assistantAnnotation(2, { sourceHash: "not-a-hash" }),
      ],
    })).toEqual([]);
  });

  it("sanitizes valid annotations and deletes invalid or request-only payloads", () => {
    expect(sanitizeChatStructuredPayload({
      summary: "keep",
      inlineAnnotations: [assistantAnnotation()],
    })).toEqual({
      summary: "keep",
      inlineAnnotations: [assistantAnnotation()],
    });

    expect(sanitizeChatStructuredPayload({
      summary: "keep",
      inlineAnnotations: [assistantAnnotation(1, { start: -1 })],
    })).toEqual({ summary: "keep" });
    expect(sanitizeChatStructuredPayload({
      summary: "keep",
      inlineAnnotations: [assistantAnnotation(1, { attachmentFileIndexes: [0] })],
    })).toEqual({ summary: "keep" });
    expect(sanitizeChatStructuredPayload({
      inlineAnnotations: "unchecked",
    })).toBeNull();
  });
});

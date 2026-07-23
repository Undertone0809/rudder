import type { ChatInlineAnnotationInput } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  canSubmitChatResponseAnnotations,
  createChatResponseAnnotationState,
  responseAnnotationReducer,
  serializeChatResponseAnnotations,
} from "./chat-response-annotations";

type AssistantAnnotationInput = Extract<
  ChatInlineAnnotationInput,
  { surface: "assistant_body" }
>;

function annotation(
  id: string,
  overrides: Partial<AssistantAnnotationInput> = {},
): AssistantAnnotationInput {
  return {
    id,
    selectedText: `Selected ${id}`,
    comment: null,
    sourceConversationId: "10000000-0000-4000-8000-000000000001",
    sourceMessageId: "20000000-0000-4000-8000-000000000001",
    surface: "assistant_body",
    sourceHash: "a".repeat(64),
    start: 0,
    end: 8,
    prefix: "",
    suffix: "",
    attachmentIds: [],
    ...overrides,
  };
}

describe("chat response annotation state", () => {
  it("keeps insertion ordinals and deduplicates an identical source range", () => {
    const first = annotation("30000000-0000-4000-8000-000000000001");
    const duplicate = annotation("30000000-0000-4000-8000-000000000002");
    const second = annotation("30000000-0000-4000-8000-000000000003", {
      start: 12,
      end: 20,
    });

    let state = createChatResponseAnnotationState();
    state = responseAnnotationReducer(state, { type: "add", annotation: first });
    const afterFirst = state;
    state = responseAnnotationReducer(state, { type: "add", annotation: duplicate });
    state = responseAnnotationReducer(state, { type: "add", annotation: second });

    expect(afterFirst.annotations.map((entry) => entry.ordinal)).toEqual([1]);
    expect(state.annotations.map((entry) => [entry.id, entry.ordinal])).toEqual([
      [first.id, 1],
      [second.id, 2],
    ]);
  });

  it("edits comments, deletes one annotation, renumbers, and clears all", () => {
    const first = annotation("30000000-0000-4000-8000-000000000001");
    const second = annotation("30000000-0000-4000-8000-000000000002", {
      start: 12,
      end: 20,
    });

    let state = createChatResponseAnnotationState([first, second]);
    state = responseAnnotationReducer(state, {
      type: "edit",
      id: second.id,
      changes: { comment: "Please verify the claim." },
    });
    expect(state.annotations[1]?.comment).toBe("Please verify the claim.");

    state = responseAnnotationReducer(state, { type: "delete", id: first.id });
    expect(state.annotations.map((entry) => [entry.id, entry.ordinal])).toEqual([
      [second.id, 1],
    ]);

    state = responseAnnotationReducer(state, { type: "clear" });
    expect(state).toEqual(createChatResponseAnnotationState());
  });

  it("keeps pending images and files owned by their annotation and serializes file indexes", () => {
    const first = annotation("30000000-0000-4000-8000-000000000001");
    const second = annotation("30000000-0000-4000-8000-000000000002", {
      start: 12,
      end: 20,
    });
    const screenshot = new File(["image"], "screenshot.png", { type: "image/png" });
    const report = new File(["report"], "report.pdf", { type: "application/pdf" });

    let state = createChatResponseAnnotationState([first, second]);
    state = responseAnnotationReducer(state, {
      type: "addFiles",
      id: first.id,
      files: [screenshot, report],
    });
    state = responseAnnotationReducer(state, {
      type: "addFiles",
      id: second.id,
      files: [screenshot],
    });

    const serialized = serializeChatResponseAnnotations(state, { fileIndexOffset: 2 });
    expect(serialized.files).toEqual([screenshot, report, screenshot]);
    expect(serialized.inlineAnnotations[0]?.attachmentFileIndexes).toEqual([2, 3]);
    expect(serialized.inlineAnnotations[1]?.attachmentFileIndexes).toEqual([4]);

    state = responseAnnotationReducer(state, {
      type: "removeFile",
      id: first.id,
      fileIndex: 0,
    });
    expect(state.pendingFilesByAnnotationId[first.id]).toEqual([report]);

    state = responseAnnotationReducer(state, { type: "delete", id: first.id });
    expect(state.pendingFilesByAnnotationId[first.id]).toBeUndefined();
  });

  it("allows annotation-only submission but rejects a completely empty composer", () => {
    const state = createChatResponseAnnotationState([
      annotation("30000000-0000-4000-8000-000000000001"),
    ]);

    expect(canSubmitChatResponseAnnotations("", state)).toBe(true);
    expect(canSubmitChatResponseAnnotations("Question", createChatResponseAnnotationState())).toBe(true);
    expect(canSubmitChatResponseAnnotations("   ", createChatResponseAnnotationState())).toBe(false);
  });
});

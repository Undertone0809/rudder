import type { ChatInlineAnnotationInput } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  canSubmitChatResponseAnnotations,
  chatResponseAnnotationsForDraft,
  createChatResponseAnnotationState,
  responseAnnotationReducer,
  serializeChatResponseAnnotations,
  validateChatResponseAnnotationAdd,
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
  it("resets a conversation-scoped draft without carrying pending files across scopes", () => {
    const first = annotation("30000000-0000-4000-8000-000000000001");
    const second = annotation("30000000-0000-4000-8000-000000000002", {
      selectedText: "Second scope",
    });
    let state = createChatResponseAnnotationState([first]);
    state = responseAnnotationReducer(state, {
      type: "addFiles",
      id: first.id,
      files: [new File(["draft"], "draft.png", { type: "image/png" })],
    });

    const next = responseAnnotationReducer(state, {
      type: "reset",
      annotations: [second],
    });

    expect(next.annotations.map((entry) => entry.id)).toEqual([second.id]);
    expect(next.pendingFilesByAnnotationId).toEqual({});
  });

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

  it("commits comment and attachment edits as one editor transaction", () => {
    const first = annotation("30000000-0000-4000-8000-000000000001", {
      attachmentIds: ["40000000-0000-4000-8000-000000000001"],
    });
    const screenshot = new File(["image"], "screenshot.png", { type: "image/png" });
    let state = createChatResponseAnnotationState([first]);

    state = responseAnnotationReducer(state, {
      type: "replaceDraft",
      id: first.id,
      comment: "Updated",
      attachmentIds: [],
      files: [screenshot],
    });

    expect(state.annotations[0]).toMatchObject({
      id: first.id,
      ordinal: 1,
      comment: "Updated",
      attachmentIds: [],
    });
    expect(state.pendingFilesByAnnotationId[first.id]).toEqual([screenshot]);
  });

  it("strips reducer-only ordinals at the draft persistence boundary", () => {
    const state = createChatResponseAnnotationState([
      annotation("30000000-0000-4000-8000-000000000001"),
    ]);

    expect(chatResponseAnnotationsForDraft(state)).toEqual([
      annotation("30000000-0000-4000-8000-000000000001"),
    ]);
    expect(chatResponseAnnotationsForDraft(state)[0]).not.toHaveProperty("ordinal");
  });

  it("rejects additions that exceed shared annotation count and text limits", () => {
    let state = createChatResponseAnnotationState(
      Array.from({ length: 10 }, (_, index) => annotation(
        `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        { start: index * 10, end: index * 10 + 8 },
      )),
    );
    const overflow = annotation("30000000-0000-4000-8000-000000000099", {
      start: 200,
      end: 208,
    });

    expect(validateChatResponseAnnotationAdd(state, overflow)).toMatch(/10/);
    expect(responseAnnotationReducer(state, { type: "add", annotation: overflow })).toBe(state);

    state = createChatResponseAnnotationState();
    const tooLong = annotation("30000000-0000-4000-8000-000000000098", {
      selectedText: "x".repeat(4_001),
      end: 4_001,
    });
    expect(validateChatResponseAnnotationAdd(state, tooLong)).toMatch(/4,000/);
    expect(responseAnnotationReducer(state, { type: "add", annotation: tooLong })).toBe(state);
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

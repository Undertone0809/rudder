import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_COMPOSER_DRAFT_VERSION,
  clearChatDraft,
  readChatComposerDraft,
  readChatDraft,
  resolveChatDraftScopeKey,
  saveChatComposerDraft,
  saveChatDraft,
} from "./chat-draft-storage";
import {
  chatResponseAnnotationsForDraft,
  createChatResponseAnnotationState,
} from "./chat-response-annotations";

const assistantAnnotation = {
  id: "10000000-0000-4000-8000-000000000001",
  selectedText: "Rudder",
  comment: "Explain this",
  sourceConversationId: "20000000-0000-4000-8000-000000000001",
  sourceMessageId: "30000000-0000-4000-8000-000000000001",
  surface: "assistant_body" as const,
  sourceHash: "a".repeat(64),
  start: 0,
  end: 6,
  prefix: "",
  suffix: " ships",
  attachmentIds: [],
};

function createLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
    key: vi.fn((index: number) => [...store.keys()][index] ?? null),
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createLocalStorageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat draft storage", () => {
  it("resolves the shared new-chat scope key", () => {
    expect(resolveChatDraftScopeKey(null)).toBe("__new__");
    expect(resolveChatDraftScopeKey("  ")).toBe("__new__");
    expect(resolveChatDraftScopeKey(" chat-1 ")).toBe("chat-1");
  });

  it("stores drafts per organization and conversation", () => {
    saveChatDraft("org-1", "chat-1", "Draft for chat 1");
    saveChatDraft("org-1", "chat-2", "Draft for chat 2");
    saveChatDraft("org-2", "chat-1", "Other org");

    expect(readChatDraft("org-1", "chat-1")).toBe("Draft for chat 1");
    expect(readChatDraft("org-1", "chat-2")).toBe("Draft for chat 2");
    expect(readChatDraft("org-2", "chat-1")).toBe("Other org");
  });

  it("stores root composer drafts separately from conversation drafts", () => {
    saveChatDraft("org-1", null, "Unsaved new chat");
    saveChatDraft("org-1", "chat-1", "Existing thread");

    expect(readChatDraft("org-1", null)).toBe("Unsaved new chat");
    expect(readChatDraft("org-1", "chat-1")).toBe("Existing thread");
  });

  it("clears only the targeted draft scope", () => {
    saveChatDraft("org-1", null, "Unsaved new chat");
    saveChatDraft("org-1", "chat-1", "Existing thread");

    clearChatDraft("org-1", "chat-1");

    expect(readChatDraft("org-1", "chat-1")).toBe("");
    expect(readChatDraft("org-1", null)).toBe("Unsaved new chat");
  });

  it("treats empty values as cleared drafts", () => {
    saveChatDraft("org-1", "chat-1", "Existing thread");
    saveChatDraft("org-1", "chat-1", "");

    expect(readChatDraft("org-1", "chat-1")).toBe("");
  });

  it("migrates legacy string-only drafts into the versioned composer shape", () => {
    localStorage.setItem("rudder:chat-drafts", JSON.stringify({
      "org-1": {
        "chat-1": "Legacy body",
      },
    }));

    expect(readChatComposerDraft("org-1", "chat-1")).toEqual({
      version: CHAT_COMPOSER_DRAFT_VERSION,
      body: "Legacy body",
      inlineAnnotations: [],
    });
  });

  it("stores annotations with a versioned organization and conversation draft", () => {
    saveChatComposerDraft("org-1", "chat-1", {
      version: CHAT_COMPOSER_DRAFT_VERSION,
      body: "",
      inlineAnnotations: [{
        ...assistantAnnotation,
        attachmentFileIndexes: [0],
      }],
    });

    expect(readChatComposerDraft("org-1", "chat-1")).toEqual({
      version: CHAT_COMPOSER_DRAFT_VERSION,
      body: "",
      inlineAnnotations: [assistantAnnotation],
    });
    expect(JSON.parse(localStorage.getItem("rudder:chat-drafts") ?? "{}")).toEqual({
      "org-1": {
        "chat-1": {
          version: CHAT_COMPOSER_DRAFT_VERSION,
          body: "",
          inlineAnnotations: [assistantAnnotation],
        },
      },
    });
  });

  it("keeps annotation-only drafts when legacy body updates clear the text", () => {
    saveChatComposerDraft("org-1", "chat-1", {
      version: CHAT_COMPOSER_DRAFT_VERSION,
      body: "Question",
      inlineAnnotations: [assistantAnnotation],
    });

    saveChatDraft("org-1", "chat-1", "");

    expect(readChatComposerDraft("org-1", "chat-1")).toEqual({
      version: CHAT_COMPOSER_DRAFT_VERSION,
      body: "",
      inlineAnnotations: [assistantAnnotation],
    });
  });

  it("round-trips reducer annotations through the explicit draft serializer", () => {
    const state = createChatResponseAnnotationState([assistantAnnotation]);
    saveChatComposerDraft("org-1", "chat-1", {
      version: CHAT_COMPOSER_DRAFT_VERSION,
      body: "",
      inlineAnnotations: chatResponseAnnotationsForDraft(state),
    });

    expect(readChatComposerDraft("org-1", "chat-1").inlineAnnotations).toEqual([
      assistantAnnotation,
    ]);
  });

  it("preserves valid annotations when one persisted item is invalid", () => {
    localStorage.setItem("rudder:chat-drafts", JSON.stringify({
      "org-1": {
        "chat-1": {
          version: CHAT_COMPOSER_DRAFT_VERSION,
          body: "Question",
          inlineAnnotations: [
            assistantAnnotation,
            { ...assistantAnnotation, id: "not-a-uuid" },
          ],
        },
      },
    }));

    expect(readChatComposerDraft("org-1", "chat-1").inlineAnnotations).toEqual([
      assistantAnnotation,
    ]);
  });

  it("drops dangling pending-file indexes and invalid persisted annotations", () => {
    localStorage.setItem("rudder:chat-drafts", JSON.stringify({
      "org-1": {
        "chat-1": {
          version: CHAT_COMPOSER_DRAFT_VERSION,
          body: "Question",
          inlineAnnotations: [{
            ...assistantAnnotation,
            attachmentFileIndexes: [0, 1],
          }],
        },
        "chat-2": {
          version: CHAT_COMPOSER_DRAFT_VERSION,
          body: "Still readable",
          inlineAnnotations: [{ nope: true }],
        },
      },
    }));

    expect(readChatComposerDraft("org-1", "chat-1").inlineAnnotations).toEqual([assistantAnnotation]);
    expect(readChatComposerDraft("org-1", "chat-2")).toEqual({
      version: CHAT_COMPOSER_DRAFT_VERSION,
      body: "Still readable",
      inlineAnnotations: [],
    });
  });
});

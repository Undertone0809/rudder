import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearChatDraft, readChatDraft, saveChatDraft } from "./chat-draft-storage";

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
});

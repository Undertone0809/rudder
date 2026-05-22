import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_CHAT_AGENT_ID,
  readRememberedChatAgentId,
  rememberChatAgentId,
  resolveDefaultChatAgentId,
  selectableChatAgents,
} from "./chat-agent-selection";

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

const agent = (id: string, status: "idle" | "running" | "terminated" = "idle") => ({ id, status });

beforeEach(() => {
  vi.stubGlobal("localStorage", createLocalStorageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat agent selection", () => {
  it("defaults to the first selectable agent instead of an empty option", () => {
    expect(resolveDefaultChatAgentId("org-1", [agent("agent-1"), agent("agent-2")])).toBe("agent-1");
  });

  it("reuses the remembered agent when it is still selectable", () => {
    rememberChatAgentId("org-1", "agent-2");

    expect(resolveDefaultChatAgentId("org-1", [agent("agent-1"), agent("agent-2")])).toBe("agent-2");
    expect(readRememberedChatAgentId("org-1")).toBe("agent-2");
  });

  it("falls back when the remembered agent is missing or terminated", () => {
    rememberChatAgentId("org-1", "agent-2");

    expect(resolveDefaultChatAgentId("org-1", [agent("agent-1"), agent("agent-2", "terminated")])).toBe("agent-1");
  });

  it("does not expose terminated agents as selectable chat agents", () => {
    expect(selectableChatAgents([agent("agent-1", "terminated"), agent("agent-2")])).toEqual([agent("agent-2")]);
  });

  it("keeps the no-agent sentinel only when no selectable agents exist", () => {
    rememberChatAgentId("org-1", NO_CHAT_AGENT_ID);

    expect(resolveDefaultChatAgentId("org-1", [agent("agent-1", "terminated")])).toBe(NO_CHAT_AGENT_ID);
    expect(readRememberedChatAgentId("org-1")).toBeUndefined();
  });
});

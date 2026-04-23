// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import type { MessengerThreadSummary } from "@rudder/shared";
import {
  getRememberedMessengerPath,
  rememberMessengerPath,
  resolveRememberedMessengerEntry,
  sanitizeRememberedMessengerPath,
} from "./messenger-memory";

const storage = new Map<string, string>();

Object.defineProperty(globalThis, "window", {
  value: globalThis,
  configurable: true,
});

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  },
  configurable: true,
});

function makeThreadSummary(threadKey: string): MessengerThreadSummary {
  return {
    threadKey,
    kind: threadKey.startsWith("chat:")
      ? "chat"
      : threadKey === "issues"
        ? "issues"
        : threadKey === "approvals"
          ? "approvals"
          : "failed-runs",
    title: threadKey,
    subtitle: null,
    preview: null,
    href: threadKey.startsWith("chat:") ? `/messenger/chat/${threadKey.slice("chat:".length)}` : `/messenger/${threadKey}`,
    latestActivityAt: new Date("2026-04-11T00:00:00.000Z"),
    lastReadAt: null,
    unreadCount: 0,
    needsAttention: false,
  };
}

describe("messenger memory", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("accepts only messenger sub-routes that can reopen a working surface", () => {
    expect(sanitizeRememberedMessengerPath("/messenger")).toBeNull();
    expect(sanitizeRememberedMessengerPath("/messenger/chat")).toBe("/messenger/chat");
    expect(sanitizeRememberedMessengerPath("/messenger/chat/chat-123?prefill=hello")).toBe("/messenger/chat/chat-123");
    expect(sanitizeRememberedMessengerPath("/messenger/issues")).toBe("/messenger/issues");
    expect(sanitizeRememberedMessengerPath("/messenger/system/failed-runs")).toBe("/messenger/system/failed-runs");
    expect(sanitizeRememberedMessengerPath("/messenger/system/agent-errors")).toBeNull();
    expect(sanitizeRememberedMessengerPath("/issues/ISS-1")).toBeNull();
  });

  it("stores remembered messenger paths per organization", () => {
    rememberMessengerPath("org-1", "/messenger/approvals");
    rememberMessengerPath("org-2", "/messenger/chat/chat-2");

    expect(getRememberedMessengerPath("org-1")).toBe("/messenger/approvals");
    expect(getRememberedMessengerPath("org-2")).toBe("/messenger/chat/chat-2");
  });

  it("falls back to new chat when the remembered chat thread no longer exists", () => {
    rememberMessengerPath("org-1", "/messenger/chat/missing-chat");

    expect(
      resolveRememberedMessengerEntry({
        orgId: "org-1",
        threadSummaries: [makeThreadSummary("chat:live-chat")],
      }),
    ).toBe("/messenger/chat");
  });

  it("reuses a remembered non-chat messenger thread directly", () => {
    rememberMessengerPath("org-1", "/messenger/issues");

    expect(
      resolveRememberedMessengerEntry({
        orgId: "org-1",
        threadSummaries: [],
      }),
    ).toBe("/messenger/issues");
  });

  it("reuses a remembered chat thread when it is still present", () => {
    rememberMessengerPath("org-1", "/messenger/chat/chat-123");

    expect(
      resolveRememberedMessengerEntry({
        orgId: "org-1",
        threadSummaries: [makeThreadSummary("chat:chat-123")],
      }),
    ).toBe("/messenger/chat/chat-123");
  });

  it("falls back to new chat when no remembered chat thread is available", () => {
    rememberMessengerPath("org-1", "/messenger/chat/chat-123");

    expect(
      resolveRememberedMessengerEntry({
        orgId: "org-1",
        threadSummaries: [],
      }),
    ).toBe("/messenger/chat");
  });
});

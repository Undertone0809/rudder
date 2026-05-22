// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import {
  readChatPendingAttachmentsForScope,
  readChatScopedPendingFiles,
  resetChatPendingAttachmentsForTests,
  resolveChatPendingAttachmentScopeKey,
  updateChatPendingAttachmentsForScope,
  updateChatScopedPendingFiles,
} from "./chat-pending-attachments";

afterEach(() => {
  resetChatPendingAttachmentsForTests();
});

describe("chat pending attachment drafts", () => {
  it("uses the same organization and new-chat scope semantics as text drafts", () => {
    expect(resolveChatPendingAttachmentScopeKey("org-1", null)).toBe("org-1:__new__");
    expect(resolveChatPendingAttachmentScopeKey("org-1", "chat-1")).toBe("org-1:chat-1");
  });

  it("keeps scoped pending files in module storage across workspace remounts", () => {
    const newChatFiles = [{ name: "new-chat.png" }] as unknown as File[];
    const existingChatFiles = [{ name: "existing-chat.txt" }] as unknown as File[];
    const newChatScope = resolveChatPendingAttachmentScopeKey("org-1", null);
    const existingChatScope = resolveChatPendingAttachmentScopeKey("org-1", "chat-1");

    updateChatPendingAttachmentsForScope(newChatScope, () => newChatFiles);
    updateChatPendingAttachmentsForScope(existingChatScope, () => existingChatFiles);

    expect(readChatPendingAttachmentsForScope(newChatScope)).toBe(newChatFiles);
    expect(readChatPendingAttachmentsForScope(existingChatScope)).toBe(existingChatFiles);
    expect(readChatPendingAttachmentsForScope(resolveChatPendingAttachmentScopeKey("org-2", null))).toEqual([]);
  });

  it("clears only the targeted persisted attachment scope", () => {
    const newChatScope = resolveChatPendingAttachmentScopeKey("org-1", null);
    const existingChatScope = resolveChatPendingAttachmentScopeKey("org-1", "chat-1");
    const newChatFiles = [{ name: "new-chat.png" }] as unknown as File[];
    const existingChatFiles = [{ name: "existing-chat.txt" }] as unknown as File[];

    updateChatPendingAttachmentsForScope(newChatScope, () => newChatFiles);
    updateChatPendingAttachmentsForScope(existingChatScope, () => existingChatFiles);
    updateChatPendingAttachmentsForScope(newChatScope, () => []);

    expect(readChatPendingAttachmentsForScope(newChatScope)).toEqual([]);
    expect(readChatPendingAttachmentsForScope(existingChatScope)).toBe(existingChatFiles);
  });

  it("updates generic scoped pending files without mutating other scopes", () => {
    const chatOneFiles = [{ name: "chat-one.png" }];
    const chatTwoFiles = [{ name: "chat-two.txt" }];
    let scopes: Record<string, Array<{ name: string }>> = {};

    scopes = updateChatScopedPendingFiles(scopes, "org-1:chat-1", () => chatOneFiles);
    scopes = updateChatScopedPendingFiles(scopes, "org-1:chat-2", () => chatTwoFiles);
    scopes = updateChatScopedPendingFiles<{ name: string }>(scopes, "org-1:chat-1", () => []);

    expect(readChatScopedPendingFiles(scopes, "org-1:chat-1")).toEqual([]);
    expect(readChatScopedPendingFiles(scopes, "org-1:chat-2")).toBe(chatTwoFiles);
    expect(scopes).not.toHaveProperty("org-1:chat-1");
  });
});

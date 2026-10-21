import type { NativeFirstSendInput } from "@/api/chats";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settlePendingChatSendMutationIdentity } from "./chat-send-mutation-storage";
import { settleNativeFirstSendResponse, settleStoppedChatInput } from "./chat-send-recovery-settlement";
import type { PendingChatStopRecovery } from "./chat-stop-recovery";
import { readNativeFirstSendIntent, updateNativeFirstSendIntent, type NativeFirstSendIntent } from "./native-chat-first-send-storage";

vi.mock("./chat-send-mutation-storage", () => ({ settlePendingChatSendMutationIdentity: vi.fn() }));
vi.mock("./native-chat-first-send-storage", () => ({
  readNativeFirstSendIntent: vi.fn(), updateNativeFirstSendIntent: vi.fn(),
}));

const firstSend: NativeFirstSendInput = {
  clientMutationId: "first-1", body: "accepted message", preferredAgentId: null,
  title: null, issueCreationMode: "manual_approval", modelOverride: null, effortOverride: null,
};
const identity = { clientMutationId: "send-1", fingerprint: "exact-fingerprint", ordinal: 1, editUserMessageId: null };
const recovery: PendingChatStopRecovery = {
  version: 1, orgId: "org-1", chatId: "chat-1", request: { controlActionId: "stop-1" },
  frozenDraft: null, previousStreamState: null, requestedAt: "2026-10-22T00:00:00Z",
  sendMutationIdentity: { kind: "native_first_send", clientMutationId: "first-1", userId: "user-1" },
};
const accepted: NativeFirstSendIntent = {
  version: 1, orgId: "org-1", userId: "user-1", clientMutationId: "first-1",
  status: "accepted", draft: firstSend, conversationId: "chat-1", createdAt: "now", updatedAt: "now",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(settlePendingChatSendMutationIdentity).mockResolvedValue(true);
  vi.mocked(readNativeFirstSendIntent).mockReturnValue(accepted);
  vi.mocked(updateNativeFirstSendIntent).mockResolvedValue({ ...accepted, status: "settled" });
});

describe("accepted input settlement", () => {
  it("settles only the exact captured conversation mutation for Stop", async () => {
    await expect(settleStoppedChatInput({ ...recovery, sendMutationIdentity: { kind: "chat_send", mutation: identity } })).resolves.toBe(true);
    expect(settlePendingChatSendMutationIdentity).toHaveBeenCalledWith({ orgId: "org-1", conversationId: "chat-1", identity });
    expect(updateNativeFirstSendIntent).not.toHaveBeenCalled();
  });

  it("settles an accepted legacy first-send under its original org/user/chat identity", async () => {
    await expect(settleStoppedChatInput(recovery)).resolves.toBe(true);
    expect(readNativeFirstSendIntent).toHaveBeenCalledWith("org-1", "user-1");
    expect(updateNativeFirstSendIntent).toHaveBeenCalledWith("org-1", "user-1", "first-1", "settled", "chat-1");
  });

  it.each([
    null, { ...accepted, clientMutationId: "newer-first" },
    { ...accepted, conversationId: "other-chat" }, { ...accepted, status: "unknown" as const },
  ])("does not release a missing, newer, different-chat or unconfirmed legacy send: %j", async (current) => {
    vi.mocked(readNativeFirstSendIntent).mockReturnValue(current);
    await expect(settleStoppedChatInput(recovery)).resolves.toBe(false);
    expect(updateNativeFirstSendIntent).not.toHaveBeenCalled();
  });

  it("preserves a failed legacy storage write as unresolved", async () => {
    vi.mocked(updateNativeFirstSendIntent).mockRejectedValue(new Error("storage unavailable"));
    await expect(settleStoppedChatInput(recovery)).resolves.toBe(false);
  });

  it.each(["ended", "finished"] as const)("warns when exact %s mutation settlement remains unresolved", async (outcome) => {
    vi.mocked(settlePendingChatSendMutationIdentity).mockResolvedValue(false);
    const markSettled = vi.fn();
    const pushToast = vi.fn();
    await settleNativeFirstSendResponse({ orgId: "org-1", conversationId: "chat-1", firstSend, identity, outcome, markSettled, pushToast });
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: `Response ${outcome}; chat send recovery still needs checking`, tone: "warn" }));
    expect(markSettled).not.toHaveBeenCalled();
  });

  it.each(["ended", "finished"] as const)("propagates exact %s identity persistence errors", async (outcome) => {
    vi.mocked(settlePendingChatSendMutationIdentity).mockRejectedValue(new Error("identity unavailable"));
    await expect(settleNativeFirstSendResponse({ orgId: "org-1", conversationId: "chat-1", firstSend, identity, outcome, markSettled: vi.fn(), pushToast: vi.fn() })).rejects.toThrow("identity unavailable");
  });

  it.each(["ended", "finished"] as const)("preserves legacy %s fallback failure notification semantics", async (outcome) => {
    const markSettled = vi.fn().mockRejectedValue(new Error("legacy storage unavailable"));
    const pushToast = vi.fn();
    await expect(settleNativeFirstSendResponse({ orgId: "org-1", conversationId: "chat-1", firstSend, identity: null, outcome, markSettled, pushToast })).resolves.toBeUndefined();
    expect(markSettled).toHaveBeenCalledWith("first-1", "chat-1");
    if (outcome === "ended") expect(pushToast).not.toHaveBeenCalled();
    else expect(pushToast).toHaveBeenCalledWith({ title: "Response finished; browser recovery still needs checking", body: "legacy storage unavailable", tone: "warn" });
  });
});

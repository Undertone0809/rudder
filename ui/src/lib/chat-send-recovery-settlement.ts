import type { NativeFirstSendInput } from "@/api/chats";
import type { ToastInput } from "@/context/ToastContext";
import {
  settlePendingChatSendMutationIdentity,
  type ChatSendMutationIdentity,
} from "./chat-send-mutation-storage";
import type { PendingChatStopRecovery } from "./chat-stop-recovery";
import {
  readNativeFirstSendIntent,
  updateNativeFirstSendIntent,
} from "./native-chat-first-send-storage";

export async function settleStoppedChatInput(recovery: PendingChatStopRecovery): Promise<boolean> {
  const identity = recovery.sendMutationIdentity;
  if (!identity) return true;
  if (identity.kind === "chat_send") {
    return settlePendingChatSendMutationIdentity({
      orgId: recovery.orgId,
      conversationId: recovery.chatId,
      identity: identity.mutation,
    });
  }

  try {
    const current = readNativeFirstSendIntent(recovery.orgId, identity.userId);
    if (!current
      || current.clientMutationId !== identity.clientMutationId
      || current.conversationId !== recovery.chatId) {
      return false;
    }
    if (current.status === "settled") return true;
    if (current.status !== "accepted") return false;
    await updateNativeFirstSendIntent(
      recovery.orgId,
      identity.userId,
      identity.clientMutationId,
      "settled",
      recovery.chatId,
    );
    return true;
  } catch {
    return false;
  }
}

export async function settleNativeFirstSendResponse(options: {
  orgId: string;
  conversationId: string;
  firstSend: NativeFirstSendInput;
  identity: ChatSendMutationIdentity | null;
  outcome: "ended" | "finished";
  markSettled: (clientMutationId: string, conversationId: string) => Promise<void>;
  pushToast: (input: ToastInput) => unknown;
}): Promise<void> {
  const { orgId, conversationId, firstSend, identity, outcome, markSettled, pushToast } = options;
  if (identity) {
    const settled = await settlePendingChatSendMutationIdentity({ orgId, conversationId, identity });
    if (!settled) {
      pushToast({
        title: `Response ${outcome}; chat send recovery still needs checking`,
        body: "The accepted message identity could not be settled locally. Reopen the chat to reconcile it.",
        tone: "warn",
      });
    }
    return;
  }
  await markSettled(firstSend.clientMutationId, conversationId).catch((error: unknown) => {
    if (outcome === "finished") {
      pushToast({
        title: "Response finished; browser recovery still needs checking",
        body: error instanceof Error ? error.message : undefined,
        tone: "warn",
      });
    }
  });
}

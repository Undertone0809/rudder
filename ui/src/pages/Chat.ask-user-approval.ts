import type { ChatAskUserResponse, ChatMessage } from "@rudderhq/shared";

export function createChatAskUserApprovalSubmit(
  message: ChatMessage,
  approve: (approvalId: string, messageId: string, response: ChatAskUserResponse) => void,
  pushToast: (toast: { title: string; tone: "error" }) => void,
) {
  return (response: ChatAskUserResponse) => {
    const approvalId = message.approval?.id ?? message.approvalId;
    if (!approvalId) {
      pushToast({ title: "This input request is no longer available.", tone: "error" });
      return;
    }
    approve(approvalId, message.id, response);
  };
}

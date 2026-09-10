// @vitest-environment node

import { describe, expect, it } from "vitest";
import { firstChatTurnRecoveryToast } from "./Chat.first-turn";

describe("first-turn recovery presentation", () => {
  it("does not add an action without a recovered draft", () => {
    expect(firstChatTurnRecoveryToast("/source-org/messenger/chat", null)).toEqual({});
  });

  it.each([
    [null, "/source-org/messenger/chat"],
    ["first-turn-recovery:new:123", "/source-org/messenger/chat?firstTurnRecovery=new%3A123"],
    ["local-app-recovery:recovered", "/source-org/messenger/chat?localAppRecoveryDraft=recovered"],
  ])("keeps recovery %s in the originating organization", (conversationId, href) => {
    expect(firstChatTurnRecoveryToast("/source-org/messenger/chat", { conversationId })).toEqual({
      persistent: true,
      action: { label: "Open recovered draft", href },
    });
  });
});

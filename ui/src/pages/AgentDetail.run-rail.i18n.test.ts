// @vitest-environment node

import { describe, expect, it } from "vitest";
import { translateMessage } from "../context/I18nContext";

describe("agent run conversation rail translations", () => {
  it("renders English singular and plural run labels", () => {
    expect(translateMessage("en", "agentRuns.conversation")).toBe("Conversation");
    expect(translateMessage("en", "agentRuns.runCount.one", { count: 1 })).toBe("1 run");
    expect(translateMessage("en", "agentRuns.runCount.many", { count: 3 })).toBe("3 runs");
    expect(translateMessage("en", "agentRuns.openAgentRunForConversation.many", {
      shortId: "abcdefgh",
      count: 3,
    })).toBe("Open agent run for conversation abcdefgh, 3 runs");
  });

  it("renders direct Chinese conversation and run labels", () => {
    expect(translateMessage("zh-CN", "agentRuns.conversation")).toBe("会话");
    expect(translateMessage("zh-CN", "agentRuns.runCount.one", { count: 1 })).toBe("1 次运行");
    expect(translateMessage("zh-CN", "agentRuns.runCount.many", { count: 3 })).toBe("3 次运行");
    expect(translateMessage("zh-CN", "agentRuns.openAgentRunForConversation.many", {
      shortId: "abcdefgh",
      count: 3,
    })).toBe("打开会话 abcdefgh 的智能体运行，共 3 次运行");
  });
});

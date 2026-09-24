import { describe, expect, it, vi } from "vitest";
import {
  createCodexAppServerServerRequestHandlers,
  type CodexAppServerInteractionOptions,
} from "./app-server-interactions.js";

function request(method: string, params: Record<string, unknown> = {}, signal = new AbortController().signal) {
  return { id: "provider-request-1", method, params, signal };
}

function handlers(overrides: Partial<CodexAppServerInteractionOptions> = {}) {
  return createCodexAppServerServerRequestHandlers({
    bypassApprovalsAndSandbox: false,
    getSessionId: () => "thread-1",
    getTurnId: () => "turn-1",
    ...overrides,
  });
}

describe("Codex App Server human interactions", () => {
  it("maps native request_user_input through the Rudder approval bridge and back", async () => {
    const requestApproval = vi.fn(async () => ({ id: "approval-1", status: "pending" as const }));
    const waitForApproval = vi.fn(async () => ({
      id: "approval-1",
      status: "approved" as const,
      inputResponse: {
        answers: [{ questionId: "codex_q1", optionIds: ["codex_q1_o2"] }],
      },
    }));
    const handler = handlers({ requestApproval, waitForApproval })["item/tool/requestUserInput"]!;

    await expect(handler(request("item/tool/requestUserInput", {
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{
        id: "provider-question-1",
        header: "Choice",
        question: "Which option?",
        isOther: false,
        isSecret: false,
        options: [
          { label: "Alpha", description: "First" },
          { label: "Beta", description: "Second" },
        ],
      }],
    }))).resolves.toEqual({
      answers: { "provider-question-1": { answers: ["Beta"] } },
    });

    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      type: "agent_runtime",
      inputRequest: {
        questions: [{
          id: "codex_q1",
          header: "Choice",
          question: "Which option?",
          options: [
            { id: "codex_q1_o1", label: "Alpha", description: "First" },
            { id: "codex_q1_o2", label: "Beta", description: "Second" },
          ],
        }],
      },
      payload: expect.objectContaining({
        provider: "codex",
        runtimeType: "codex_local",
        sessionId: "thread-1",
        turnId: "turn-1",
        requestId: "provider-request-1",
        interactionKind: "question",
      }),
    }));
    expect(waitForApproval).toHaveBeenCalledWith("approval-1", 30 * 60_000);
  });

  it("fails closed for secret questions and rejected or incomplete answers", async () => {
    const requestApproval = vi.fn(async () => ({ id: "approval-1", status: "pending" as const }));
    const waitForApproval = vi.fn(async () => ({
      id: "approval-1",
      status: "approved" as const,
    }));
    const handler = handlers({ requestApproval, waitForApproval })["item/tool/requestUserInput"]!;
    const params = {
      questions: [{
        id: "provider-question-1",
        question: "Secret?",
        isOther: false,
        isSecret: true,
        options: [
          { label: "A", description: "First" },
          { label: "B", description: "Second" },
        ],
      }],
    };

    await expect(handler(request("item/tool/requestUserInput", params))).rejects.toThrow("Secret Codex");
    expect(requestApproval).not.toHaveBeenCalled();

    await expect(handlers({
      requestApproval,
      waitForApproval: async () => ({ id: "approval-1", status: "rejected" as const }),
    })["item/tool/requestUserInput"]!(request("item/tool/requestUserInput", {
      ...params,
      questions: [{ ...params.questions[0], isSecret: false }],
    }))).rejects.toThrow("was not approved");
  });

  it("routes command and file approvals through Rudder and preserves deny/cancel", async () => {
    const requestApproval = vi.fn(async () => ({ id: "approval-1", status: "pending" as const }));
    const waitForApproval = vi.fn(async () => ({ id: "approval-1", status: "approved" as const }));
    const approvalHandlers = handlers({ requestApproval, waitForApproval });

    await expect(approvalHandlers["item/commandExecution/requestApproval"]!(request(
      "item/commandExecution/requestApproval",
      { turnId: "turn-1", itemId: "command-1", command: "printf safe", cwd: "/tmp" },
    ))).resolves.toEqual({ decision: "accept" });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        interactionKind: "permission",
        toolName: "item/commandExecution/requestApproval",
        command: "printf safe",
        cwd: "/tmp",
        choices: ["allow", "deny"],
      }),
    }));

    const deniedHandlers = handlers({
      requestApproval: async () => ({ id: "approval-denied", status: "pending" }),
      waitForApproval: async () => ({ id: "approval-denied", status: "rejected" }),
    });
    await expect(deniedHandlers["item/commandExecution/requestApproval"]!(request(
      "item/commandExecution/requestApproval",
    ))).resolves.toEqual({ decision: "decline" });

    const cancelled = new AbortController();
    cancelled.abort(new Error("attempt ended"));
    await expect(approvalHandlers["item/fileChange/requestApproval"]!(request(
      "item/fileChange/requestApproval",
      {},
      cancelled.signal,
    ))).resolves.toEqual({ decision: "cancel" });
  });

  it("declines permissions without an approval bridge and keeps explicit bypass behavior", async () => {
    await expect(handlers()["item/commandExecution/requestApproval"]!(request(
      "item/commandExecution/requestApproval",
    ))).resolves.toEqual({ decision: "decline" });
    await expect(createCodexAppServerServerRequestHandlers(true)["item/fileChange/requestApproval"]!(request(
      "item/fileChange/requestApproval",
    ))).resolves.toEqual({ decision: "accept" });
    await expect(createCodexAppServerServerRequestHandlers(true).execCommandApproval!(request(
      "execCommandApproval",
    ))).resolves.toEqual({ decision: "approved" });
    await expect(handlers()["item/permissions/requestApproval"]!(request(
      "item/permissions/requestApproval",
    ))).rejects.toThrow("unsupported by the current Rudder approval contract");
  });
});

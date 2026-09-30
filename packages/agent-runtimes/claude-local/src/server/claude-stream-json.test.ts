import type { ChatAskUserRequest, ChatAskUserResponse } from "@rudderhq/agent-runtime-utils";
import { runningProcesses } from "@rudderhq/agent-runtime-utils/server-utils";
import { describe, expect, it, vi } from "vitest";
import {
  createClaudeStreamControlHandle,
  startClaudeStreamJsonProcess,
  type ClaudeStreamJsonProcess,
} from "./claude-stream-json.js";

const SESSION_ID = "session-1";
const INITIAL_UUID = "00000000-0000-4000-8000-000000000001";

function fakeClaudeCliScript({ completeAfterSecondMessage }: { completeAfterSecondMessage: boolean }): string {
  return `
    const readline = require("node:readline");
    const input = readline.createInterface({ input: process.stdin });
    let messageCount = 0;
    input.on("line", (line) => {
      const message = JSON.parse(line);
      messageCount += 1;
      process.stdout.write(JSON.stringify({
        type: "user",
        isReplay: true,
        uuid: message.uuid,
        session_id: ${JSON.stringify(SESSION_ID)},
      }) + "\\n");
      if (messageCount === 1) {
        process.stdout.write(JSON.stringify({
          type: "assistant",
          uuid: "turn-1",
          session_id: ${JSON.stringify(SESSION_ID)},
          message: { content: [{ type: "text", text: "working" }] },
        }) + "\\n");
      } else if (${completeAfterSecondMessage ? "true" : "false"}) {
        process.stdout.write(JSON.stringify({
          type: "result",
          uuid: "result-1",
          session_id: ${JSON.stringify(SESSION_ID)},
          subtype: "success",
          result: "done",
        }) + "\\n");
      }
    });
  `;
}

function fakeControlClaudeCliScript({
  requestId,
  toolName,
  duplicateRequest = false,
  input,
}: {
  requestId: string;
  toolName: string;
  duplicateRequest?: boolean;
  input?: Record<string, unknown>;
}): string {
  const requestInput = input ?? {
    command: "SECRET_TOOL_INPUT",
    questions: [{ question: "SECRET_QUESTION_TEXT" }],
  };
  const requestLine = JSON.stringify(`${JSON.stringify({
    type: "control_request",
    request_id: requestId,
    session_id: SESSION_ID,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      tool_use_id: "tool-use-1",
      input: requestInput,
    },
  })}\n`);
  return `
    const readline = require("node:readline");
    const input = readline.createInterface({ input: process.stdin });
    let sentRequest = false;
    input.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type === "user" && !sentRequest) {
        sentRequest = true;
        process.stdout.write(JSON.stringify({
          type: "user",
          isReplay: true,
          uuid: message.uuid,
          session_id: ${JSON.stringify(SESSION_ID)},
        }) + "\\n");
        process.stdout.write(${requestLine});
        ${duplicateRequest ? `process.stdout.write(${requestLine});` : ""}
        return;
      }
      if (message.type === "control_response") {
        process.stdout.write(JSON.stringify({
          type: "test_control_response",
          observed: message,
          session_id: ${JSON.stringify(SESSION_ID)},
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "result",
          uuid: "result-1",
          session_id: ${JSON.stringify(SESSION_ID)},
          subtype: "success",
          result: "done",
        }) + "\\n");
      }
    });
  `;
}

function startFakeProcess(
  runId: string,
  script: string,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> = async () => {},
  extra: Partial<Parameters<typeof startClaudeStreamJsonProcess>[0]> = {},
) {
  return startClaudeStreamJsonProcess({
    runId,
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: {},
    timeoutSec: 10,
    graceSec: 1,
    onLog,
    ...extra,
  });
}

async function dispose(stream: ClaudeStreamJsonProcess | null): Promise<void> {
  await stream?.close().catch(() => undefined);
}

function observedControlResponses(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.type === "test_control_response")
    .map((event) => event.observed as Record<string, unknown>);
}

describe("Claude stream-json control", () => {
  it("does not advertise or send replay-only stream-json input as in-flight Steer", async () => {
    const runId = "claude-stream-json-test-control";
    const logs: string[] = [];
    let stream: ClaudeStreamJsonProcess | null = null;
    try {
      stream = startFakeProcess(runId, fakeClaudeCliScript({ completeAfterSecondMessage: true }), async (kind, chunk) => {
        logs.push(`${kind}:${chunk}`);
      });
      const handle = createClaudeStreamControlHandle(stream);
      expect(handle.capabilities).toEqual({ steer: "interrupt_continue", interrupt: "process" });

      await expect(stream.sendUserMessage("initial", INITIAL_UUID)).resolves.toBe(INITIAL_UUID);
      await expect(stream.waitForReplay(INITIAL_UUID)).resolves.toBeUndefined();
      await expect(stream.waitForProviderTurn()).resolves.toBe(true);
      const sendUserMessage = vi.spyOn(stream, "sendUserMessage");

      await expect(handle.steer({
        text: "continue",
        clientMessageId: "client-message-1",
      })).resolves.toEqual({
        disposition: "unsupported",
        reason: "Claude Code stream-json replay confirms message receipt only; it does not confirm application to the in-flight turn.",
      });

      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(stream.getProviderTurnId()).toBe("turn-1");
      const result = await stream.close();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`"isReplay":true`);
      expect(result.stdout).toContain(INITIAL_UUID);
      expect(logs.some((entry) => entry.startsWith("stdout:"))).toBe(true);
      expect(runningProcesses.has(runId)).toBe(false);
    } finally {
      await dispose(stream);
      runningProcesses.delete(runId);
    }
  });

  it("uses process lifecycle interruption and removes the live process", async () => {
    const runId = "claude-stream-json-test-interrupt";
    let stream: ClaudeStreamJsonProcess | null = null;
    try {
      stream = startFakeProcess(runId, fakeClaudeCliScript({ completeAfterSecondMessage: false }));
      await stream.sendUserMessage("initial", INITIAL_UUID);
      await stream.waitForReplay(INITIAL_UUID);
      expect(runningProcesses.has(runId)).toBe(true);

      await expect(stream.interrupt()).resolves.toBe("waiting_safe_boundary");
      const result = await stream.close();
      expect(result.signal).toBe("SIGTERM");
      expect(runningProcesses.has(runId)).toBe(false);
    } finally {
      await dispose(stream);
      runningProcesses.delete(runId);
    }
  });

  it("bridges an approved can_use_tool request back with the exact request id", async () => {
    const runId = "claude-stream-json-test-approval-allow";
    const requestId = "claude-request-allow-1";
    const logs: string[] = [];
    let approvalPayload: Record<string, unknown> | null = null;
    let stream: ClaudeStreamJsonProcess | null = null;
    try {
      stream = startFakeProcess(
        runId,
        fakeControlClaudeCliScript({ requestId, toolName: "Bash" }),
        async (kind, chunk) => {
          logs.push(`${kind}:${chunk}`);
        },
        {
          requestApproval: async (request) => {
            approvalPayload = request.payload;
            return { id: "rudder-approval-allow", status: "pending" };
          },
          waitForApproval: async () => ({ id: "rudder-approval-allow", status: "approved" }),
          isCurrentAttempt: () => true,
          attemptEpoch: 17,
        },
      );
      await stream.sendUserMessage("run the approved tool", INITIAL_UUID);
      await stream.waitForTurn();
      const result = await stream.close();
      const responses = observedControlResponses(result.stdout);

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            behavior: "allow",
            toolUseID: "tool-use-1",
          },
        },
      });
      expect(approvalPayload).toMatchObject({
        provider: "claude",
        runtimeType: "claude_local",
        protocol: "stream-json",
        requestId,
        toolName: "Bash",
        toolUseId: "tool-use-1",
        inputKeys: ["command", "questions"],
        attemptEpoch: 17,
        choices: ["allow", "deny"],
      });
      expect(JSON.stringify(approvalPayload)).not.toContain("SECRET_TOOL_INPUT");
      expect(JSON.stringify(approvalPayload)).not.toContain("SECRET_QUESTION_TEXT");
      expect(result.stdout).not.toContain("SECRET_TOOL_INPUT");
      expect(result.stdout).not.toContain("SECRET_QUESTION_TEXT");
      expect(logs.join("")).not.toContain("SECRET_TOOL_INPUT");
      expect(logs.join("")).not.toContain("SECRET_QUESTION_TEXT");
    } finally {
      await dispose(stream);
      runningProcesses.delete(runId);
    }
  });

  it("denies a rejected can_use_tool request without leaking the decision note", async () => {
    const runId = "claude-stream-json-test-approval-deny";
    const requestId = "claude-request-deny-1";
    let stream: ClaudeStreamJsonProcess | null = null;
    try {
      stream = startFakeProcess(
        runId,
        fakeControlClaudeCliScript({ requestId, toolName: "Bash" }),
        async () => {},
        {
          requestApproval: async () => ({ id: "rudder-approval-deny", status: "pending" }),
          waitForApproval: async () => ({
            id: "rudder-approval-deny",
            status: "rejected",
            decisionNote: "SECRET_DECISION_NOTE",
          }),
        },
      );
      await stream.sendUserMessage("run the denied tool", INITIAL_UUID);
      await stream.waitForTurn();
      const result = await stream.close();
      const responses = observedControlResponses(result.stdout);

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        response: {
          request_id: requestId,
          response: {
            behavior: "deny",
            message: "Rudder approval was not granted.",
            decisionClassification: "user_reject",
          },
        },
      });
      expect(result.stdout).not.toContain("SECRET_DECISION_NOTE");
    } finally {
      await dispose(stream);
      runningProcesses.delete(runId);
    }
  });

  it("deduplicates a repeated request id to one approval and one response", async () => {
    const runId = "claude-stream-json-test-approval-duplicate";
    const requestId = "claude-request-duplicate-1";
    let approvalCalls = 0;
    let stream: ClaudeStreamJsonProcess | null = null;
    try {
      stream = startFakeProcess(
        runId,
        fakeControlClaudeCliScript({ requestId, toolName: "Bash", duplicateRequest: true }),
        async () => {},
        {
          requestApproval: async () => {
            approvalCalls += 1;
            return { id: "rudder-approval-duplicate", status: "pending" };
          },
          waitForApproval: async () => ({ id: "rudder-approval-duplicate", status: "approved" }),
        },
      );
      await stream.sendUserMessage("run once", INITIAL_UUID);
      await stream.waitForTurn();
      const result = await stream.close();

      expect(approvalCalls).toBe(1);
      expect(observedControlResponses(result.stdout)).toHaveLength(1);
    } finally {
      await dispose(stream);
      runningProcesses.delete(runId);
    }
  });

  it("denies a control request that arrives on a stale attempt", async () => {
    const runId = "claude-stream-json-test-approval-stale";
    const requestId = "claude-request-stale-1";
    let approvalCalls = 0;
    let stream: ClaudeStreamJsonProcess | null = null;
    try {
      stream = startFakeProcess(
        runId,
        fakeControlClaudeCliScript({ requestId, toolName: "Bash" }),
        async () => {},
        {
          requestApproval: async () => {
            approvalCalls += 1;
            return { id: "unexpected", status: "pending" };
          },
          waitForApproval: async () => ({ id: "unexpected", status: "approved" }),
          isCurrentAttempt: () => false,
        },
      );
      await stream.sendUserMessage("stale attempt", INITIAL_UUID);
      await stream.waitForTurn();
      const result = await stream.close();
      const responses = observedControlResponses(result.stdout);

      expect(approvalCalls).toBe(0);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        response: {
          request_id: requestId,
          response: { behavior: "deny" },
        },
      });
    } finally {
      await dispose(stream);
      runningProcesses.delete(runId);
    }
  });

  it("cancels a pending approval when the stream is interrupted without a late response", async () => {
    const runId = "claude-stream-json-test-approval-cancel";
    const requestId = "claude-request-cancel-1";
    let resolveApprovalWait!: () => void;
    let resolveApprovalRequested!: () => void;
    const approvalRequested = new Promise<void>((resolve) => {
      resolveApprovalRequested = resolve;
    });
    const approvalWait = new Promise<void>((resolve) => {
      resolveApprovalWait = resolve;
    });
    let stream: ClaudeStreamJsonProcess | null = null;
    try {
      stream = startFakeProcess(
        runId,
        fakeControlClaudeCliScript({ requestId, toolName: "Bash" }),
        async () => {},
        {
          requestApproval: async () => {
            resolveApprovalRequested();
            return { id: "rudder-approval-cancel", status: "pending" };
          },
          waitForApproval: async () => {
            await approvalWait;
            return { id: "rudder-approval-cancel", status: "approved" };
          },
        },
      );
      await stream.sendUserMessage("cancel while waiting", INITIAL_UUID);
      await approvalRequested;
      await expect(stream.interrupt()).resolves.toBe("waiting_safe_boundary");
      const result = await stream.close();
      resolveApprovalWait();

      expect(observedControlResponses(result.stdout)).toHaveLength(0);
      expect(result.signal).toBe("SIGTERM");
    } finally {
      resolveApprovalWait();
      await dispose(stream);
      runningProcesses.delete(runId);
    }
  });

  it("fails closed for AskUserQuestion and redacts question text from the stream", async () => {
    const runId = "claude-stream-json-test-approval-ask-user";
    const requestId = "claude-request-ask-user-1";
    let approvalCalls = 0;
    let stream: ClaudeStreamJsonProcess | null = null;
    try {
      stream = startFakeProcess(
        runId,
        fakeControlClaudeCliScript({ requestId, toolName: "AskUserQuestion" }),
        async () => {},
        {
          requestApproval: async () => {
            approvalCalls += 1;
            return { id: "unexpected", status: "pending" };
          },
          waitForApproval: async () => ({ id: "unexpected", status: "approved" }),
        },
      );
      await stream.sendUserMessage("ask the user", INITIAL_UUID);
      await stream.waitForTurn();
      const result = await stream.close();
      const responses = observedControlResponses(result.stdout);

      expect(approvalCalls).toBe(0);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        response: {
          request_id: requestId,
          response: {
            behavior: "deny",
            message: "Claude AskUserQuestion contained an unsupported structured request.",
          },
        },
      });
      expect(result.stdout).not.toContain("SECRET_QUESTION_TEXT");
      expect(result.stdout).not.toContain("SECRET_TOOL_INPUT");
    } finally {
      await dispose(stream);
      runningProcesses.delete(runId);
    }
  });

  it("round-trips structured AskUserQuestion answers through updatedInput", async () => {
    const runId = "claude-stream-json-test-approval-ask-user-structured";
    const requestId = "claude-request-ask-user-structured-1";
    const input = {
      questions: [
        {
          question: "Which rollout path should Claude use?",
          header: "Rollout",
          options: [
            { label: "Fast", description: "Ship the smallest change" },
            { label: "Safe", description: "Keep the rollback path" },
          ],
          multiSelect: false,
        },
        {
          question: "Which follow-ups should be included?",
          header: "Follow-ups",
          options: [
            { label: "Tests", description: "Add regression tests" },
            { label: "Docs", description: "Update operator docs" },
          ],
          multiSelect: true,
        },
      ],
      secretProviderField: "SECRET_PROVIDER_INPUT",
    } as unknown as Record<string, unknown>;
    let approvalPayload: Record<string, unknown> | null = null;
    let inputRequest: ChatAskUserRequest | undefined;
    let stream: ClaudeStreamJsonProcess | null = null;
    try {
      stream = startFakeProcess(
        runId,
        fakeControlClaudeCliScript({ requestId, toolName: "AskUserQuestion", input }),
        async () => {},
        {
          requestApproval: async (request) => {
            approvalPayload = request.payload;
            inputRequest = request.inputRequest;
            return { id: "rudder-approval-ask-user-structured", status: "pending" };
          },
          waitForApproval: async (): Promise<{
            id: string;
            status: "approved";
            inputResponse: ChatAskUserResponse;
          }> => ({
            id: "rudder-approval-ask-user-structured",
            status: "approved",
            inputResponse: {
              answers: [
                { questionId: "q1", optionIds: ["q1-option1"] },
                { questionId: "q2", optionIds: ["q2-option1"], freeformText: "Keep the report short." },
              ],
            },
          }),
        },
      );
      await stream.sendUserMessage("ask the user", INITIAL_UUID);
      await stream.waitForTurn();
      const result = await stream.close();
      const responses = observedControlResponses(result.stdout);

      expect(inputRequest).toMatchObject({
        questions: [
          {
            id: "q1",
            question: "Which rollout path should Claude use?",
            options: [{ id: "q1-option1", label: "Fast" }, { id: "q1-option2", label: "Safe" }],
          },
          {
            id: "q2",
            selectionMode: "multiple",
            allowFreeform: true,
          },
        ],
      });
      expect(approvalPayload).toMatchObject({ inputRequest });
      expect(JSON.stringify(approvalPayload)).not.toContain("SECRET_PROVIDER_INPUT");
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            behavior: "allow",
            toolUseID: "tool-use-1",
            updatedInput: {
              answers: {
                "Which rollout path should Claude use?": "Fast",
                "Which follow-ups should be included?": "Tests, Keep the report short.",
              },
            },
          },
        },
      });
    } finally {
      await dispose(stream);
      runningProcesses.delete(runId);
    }
  });

  it("fails closed when an approved AskUserQuestion carries an invalid typed response", async () => {
    const runId = "claude-stream-json-test-approval-ask-user-invalid-response";
    const requestId = "claude-request-ask-user-invalid-response-1";
    const input = {
      questions: [{
        question: "Which rollout path should Claude use?",
        header: "Rollout",
        options: [
          { label: "Fast", description: "Ship the smallest change" },
          { label: "Safe", description: "Keep the rollback path" },
        ],
        multiSelect: false,
      }],
    } as unknown as Record<string, unknown>;
    let stream: ClaudeStreamJsonProcess | null = null;
    try {
      stream = startFakeProcess(
        runId,
        fakeControlClaudeCliScript({ requestId, toolName: "AskUserQuestion", input }),
        async () => {},
        {
          requestApproval: async () => ({ id: "rudder-approval-ask-user-invalid-response", status: "pending" }),
          waitForApproval: async (): Promise<{
            id: string;
            status: "approved";
            inputResponse: ChatAskUserResponse;
          }> => ({
            id: "rudder-approval-ask-user-invalid-response",
            status: "approved",
            inputResponse: {
              answers: [{
                questionId: "q1",
                optionIds: ["q1-option-does-not-exist"],
                freeformText: "SECRET_INVALID_ANSWER",
              }],
            },
          }),
        },
      );
      await stream.sendUserMessage("ask the user", INITIAL_UUID);
      await stream.waitForTurn();
      const result = await stream.close();
      const responses = observedControlResponses(result.stdout);

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        response: {
          request_id: requestId,
          response: {
            behavior: "deny",
            message: "Rudder structured answer could not be validated.",
          },
        },
      });
      expect(JSON.stringify(responses)).not.toContain("SECRET_INVALID_ANSWER");
      expect(result.stdout).not.toContain("SECRET_INVALID_ANSWER");
    } finally {
      await dispose(stream);
      runningProcesses.delete(runId);
    }
  });

  it("cleans lifecycle state when the child cannot start", async () => {
    const runId = "claude-stream-json-test-spawn-error";
    const stream = startClaudeStreamJsonProcess({
      runId,
      command: "/definitely/missing/claude",
      args: [],
      cwd: process.cwd(),
      env: {},
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
    });

    await expect(stream.close()).rejects.toThrow();
    expect(runningProcesses.has(runId)).toBe(false);
  });
});

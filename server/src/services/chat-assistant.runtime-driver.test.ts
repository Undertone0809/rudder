import type { AgentRuntimeApprovalRequest } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import { describe, expect, it, vi } from "vitest";
import { createChatAssistantRuntimeDriverPorts } from "./chat-assistant.runtime-driver.js";
import type { RuntimeDriver, RuntimeDriverApprovalBridge } from "./runtime-kernel/runtime-driver.js";

describe("Chat Runtime Driver approval identity", () => {
  it.each([
    { nativeRequestId: "cursor-question-7", requestId: "cursor-question-7" },
    { nativeRequestId: 42, requestId: "42" },
  ])("preserves native request id $requestId through the response bridge", async ({ nativeRequestId, requestId }) => {
    const approvalBridge: RuntimeDriverApprovalBridge = {
      requestApproval: vi.fn(async () => ({ id: "approval-1", status: "pending" as const })),
      waitForApproval: vi.fn(async () => ({ id: "approval-1", status: "approved" as const })),
    };
    const nativeRequest: AgentRuntimeApprovalRequest = {
      type: "agent_runtime",
      payload: { runtimeType: "cursor", nativeRequestId },
    };
    const respondToRequest = vi.fn(async () => ({
      status: "supported" as const,
      value: {
        handle: { id: "approval-1", status: "pending" as const },
        decision: { id: "approval-1", status: "approved" as const },
      },
    }));
    const driver = { respondToRequest } as unknown as RuntimeDriver;
    const ports = createChatAssistantRuntimeDriverPorts({} as Db).createAttemptPorts({
      primaryRuntimeType: "cursor",
      providerBinding: { orgId: "org-1", id: "binding-1", hostId: "local", profileId: "profile-1" },
      cwd: "/tmp",
      continuationTransport: {},
      approvalBridge,
      runId: "run-1",
      orgId: "org-1",
      chatId: "chat-1",
      initialDriver: driver,
      nativeDriverRequired: true,
      getAttemptId: () => "attempt-1",
      finishAttempt: vi.fn(async () => undefined),
    });

    const handle = await ports.requestApproval(nativeRequest);
    await expect(ports.waitForApproval(handle.id, 1_000)).resolves.toMatchObject({
      id: "approval-1",
      status: "approved",
    });

    expect(approvalBridge.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ nativeRequestId, requestId }),
    }));
    expect(respondToRequest).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ nativeRequestId, requestId }),
    }), 1_000);
  });
});

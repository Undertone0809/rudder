import { RUDDER_AGENT_HEARTBEAT_INSTRUCTION } from "@rudderhq/agent-runtime-utils/server-utils";
import { describe, expect, it } from "vitest";
import { buildWakePayload, buildWakeText } from "./execute.js";

describe("OpenClaw Delegation delivery", () => {
  it("renders the bounded task without the heartbeat self-check instruction", () => {
    const payload = buildWakePayload({
      runId: "run-1",
      agent: {
        id: "agent-1",
        orgId: "org-1",
        name: "Target",
        agentRuntimeType: "openclaw_gateway",
        agentRuntimeConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {},
      context: {
        scene: "delegation",
        sourceRunId: "source-run-1",
        delegationTask: "Inspect the target independently",
      },
      onLog: async () => {},
    });
    const text = buildWakeText(payload, {
      RUDDER_RUN_ID: "run-1",
      RUDDER_AGENT_ID: "agent-1",
      RUDDER_ORG_ID: "org-1",
      RUDDER_DELEGATION_TASK: "Inspect the target independently",
    });

    expect(text).toContain("## Delegated Task");
    expect(text).toContain("Inspect the target independently");
    expect(text).toContain("Source Run source-run-1 is provenance only");
    expect(text).toContain("Preserve Delegation isolation and provenance-only source semantics");
    expect(text).not.toContain("Preserve the Rudder heartbeat semantics");
    expect(text).not.toContain(RUDDER_AGENT_HEARTBEAT_INSTRUCTION);
  });
});

describe("OpenClaw heartbeat delivery", () => {
  it("keeps heartbeat instructions out of explicit Issue wake text", () => {
    const payload = buildWakePayload({
      runId: "run-issue-1",
      agent: {
        id: "agent-1",
        orgId: "org-1",
        name: "Target",
        agentRuntimeType: "openclaw_gateway",
        agentRuntimeConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {},
      context: {
        scene: "issue",
        taskId: "task-1",
        issueId: "issue-1",
        wakeReason: "issue_assigned",
      },
      onLog: async () => {},
    });
    const text = buildWakeText(payload, {
      RUDDER_RUN_ID: "run-issue-1",
      RUDDER_AGENT_ID: "agent-1",
      RUDDER_ORG_ID: "org-1",
      RUDDER_TASK_ID: "task-1",
      RUDDER_WAKE_REASON: "issue_assigned",
    });

    expect(text).not.toContain("<rudder_heartbeat_instruction>");
    expect(text).not.toContain(RUDDER_AGENT_HEARTBEAT_INSTRUCTION);
    expect(text).toContain("GET /api/issues/{issueId}");
    expect(text).toContain("RUDDER_TASK_ID=task-1");
  });
});

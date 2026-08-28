import { describe, expect, it, vi } from "vitest";

const mockRunChildProcess = vi.hoisted(() => vi.fn());
vi.mock("../utils.js", () => ({
  asNumber: (value: unknown, fallback: number) => typeof value === "number" ? value : fallback,
  asString: (value: unknown, fallback: string) => typeof value === "string" ? value : fallback,
  asStringArray: (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
  buildRudderEnv: () => ({ RUDDER_AGENT_ID: "agent-1" }),
  parseObject: (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value : {},
  redactEnvForLogs: (value: unknown) => value,
  runChildProcess: mockRunChildProcess,
}));

import { execute } from "./execute.js";

describe("process adapter Delegation delivery", () => {
  it("passes the bounded task through stdin and the dedicated environment key", async () => {
    mockRunChildProcess.mockResolvedValue({
      timedOut: false,
      exitCode: 0,
      signal: null,
      stdout: "completed",
      stderr: "",
    });
    const meta = vi.fn();

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        orgId: "org-1",
        name: "Target",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "worker" },
      context: {
        scene: "delegation",
        delegationTask: "Inspect the target independently",
      },
      onLog: async () => {},
      onMeta: meta,
    });

    expect(result.summary).toBe("completed");
    expect(mockRunChildProcess).toHaveBeenCalledWith(
      "run-1",
      "worker",
      [],
      expect.objectContaining({
        stdin: "Rudder Delegation Run task:\n\nInspect the target independently",
        env: expect.objectContaining({
          RUDDER_AGENT_ID: "agent-1",
          RUDDER_DELEGATION_TASK: "Inspect the target independently",
        }),
      }),
    );
    expect(meta).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Rudder Delegation Run task:\n\nInspect the target independently",
    }));
  });
});

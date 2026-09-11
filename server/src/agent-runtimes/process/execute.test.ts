import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunChildProcess = vi.hoisted(() => vi.fn());
const mockRunNativeChildProcessV2 = vi.hoisted(() => vi.fn());
vi.mock("../utils.js", () => ({
  asNumber: (value: unknown, fallback: number) => typeof value === "number" ? value : fallback,
  asString: (value: unknown, fallback: string) => typeof value === "string" ? value : fallback,
  asStringArray: (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
  buildRudderEnv: () => ({ RUDDER_AGENT_ID: "agent-1" }),
  parseObject: (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value : {},
  redactEnvForLogs: (value: unknown) => value,
  resolveSpawnTarget: async (command: string, args: string[]) => ({ command: `/usr/local/bin/${command}`, args }),
  runChildProcess: mockRunChildProcess,
  runNativeChildProcessV2: mockRunNativeChildProcessV2,
}));

import { execute } from "./execute.js";

describe("process adapter Delegation delivery", () => {
  beforeEach(() => {
    mockRunChildProcess.mockReset();
    mockRunNativeChildProcessV2.mockReset();
  });

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
        sourceRunId: "source-run-1",
        sourceAgentId: "source-agent-1",
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
        stdin: expect.stringContaining("Source Run source-run-1 and Source Agent source-agent-1 are provenance only"),
        env: expect.objectContaining({
          RUDDER_AGENT_ID: "agent-1",
          RUDDER_DELEGATION_TASK: "Inspect the target independently",
        }),
      }),
    );
    expect(meta).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Do not inherit the source Run's transcript, session, workspace, credentials, environment variables, or arbitrary paths"),
    }));
    expect(mockRunChildProcess.mock.calls[0]?.[3]?.stdin).toContain("## Delegated Task\n\nInspect the target independently");
  });

  it("uses the authority-bound v2 runner for a host-injected authority", async () => {
    mockRunNativeChildProcessV2.mockResolvedValue({
      timedOut: false,
      exitCode: 0,
      signal: null,
      stdout: "native completed",
      stderr: "",
    });
    const authority = {
      authorityVersion: 1,
      runtimeIdentity: { organizationId: "org-1", agentId: "agent-1", runId: "run-2" },
      ownership: { epoch: 3, fence: "fence-3" },
      lease: { owner: "worker-1", issuedAtMillis: 1_000, expiresAtMillis: 60_000 },
      attempt: 2,
      requestId: "request-run-2",
      bindingDigest: "a".repeat(64),
      receiptContext: { runtimeRoot: "/tmp/rudder-receipts", ownerToken: "owner-run-2" },
    };

    const result = await execute({
      runId: "run-2",
      agent: {
        id: "agent-1",
        orgId: "org-1",
        name: "Target",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "worker", args: ["--native"] },
      context: { chatMode: true, chatPrompt: "Run the native process" },
      nativeProcessAuthority: authority,
      onLog: async () => {},
    });

    expect(result.summary).toBe("native completed");
    expect(mockRunChildProcess).not.toHaveBeenCalled();
    expect(mockRunNativeChildProcessV2).toHaveBeenCalledWith(
      "run-2",
      "/usr/local/bin/worker",
      ["--native"],
      expect.objectContaining({ authority, stdin: "Run the native process" }),
    );
  });

  it("treats a missing exit code as a failed process", async () => {
    mockRunChildProcess.mockResolvedValue({
      timedOut: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "stopped before exit",
    });

    const result = await execute({
      runId: "run-null-exit",
      agent: {
        id: "agent-1",
        orgId: "org-1",
        name: "Target",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "worker" },
      context: {},
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: null,
      timedOut: false,
      errorCode: "process_exit_unknown",
      errorMessage: "Process ended without a terminal exit code",
    });
  });

  it("maps an authority-bound terminal failure even when the app exit code is zero", async () => {
    mockRunNativeChildProcessV2.mockResolvedValue({
      timedOut: false,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      terminalStatus: "failed",
      errorCode: "lease_expired",
    });

    const result = await execute({
      runId: "run-failed-terminal",
      agent: {
        id: "agent-1",
        orgId: "org-1",
        name: "Target",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "worker" },
      context: {},
      nativeProcessAuthority: {
        authorityVersion: 1,
        runtimeIdentity: { organizationId: "org-1", agentId: "agent-1", runId: "run-failed-terminal" },
        ownership: { epoch: 3, fence: "fence-3" },
        lease: { owner: "worker-1", issuedAtMillis: 1_000, expiresAtMillis: 60_000 },
        attempt: 2,
        requestId: "request-run-failed-terminal",
        bindingDigest: "a".repeat(64),
        receiptContext: { runtimeRoot: "/tmp/rudder-receipts", ownerToken: "owner-run-failed-terminal" },
      },
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 0,
      errorCode: "lease_expired",
      errorMessage: "Process exited with terminal status failed (lease_expired)",
    });
  });
});

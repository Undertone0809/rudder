import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntimeInvocationMeta } from "@rudderhq/agent-runtime-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexSessionParams,
  codexChatStdoutCapturePolicy,
  execute,
  resolveCodexAgentHome,
  validateCodexResumeSession,
} from "./execute.js";

const { executeCodexAppServerChatMock, runChildProcessMock } = vi.hoisted(() => ({
  executeCodexAppServerChatMock: vi.fn(),
  runChildProcessMock: vi.fn(),
}));

vi.mock("./app-server-chat.js", () => ({
  executeCodexAppServerChat: executeCodexAppServerChatMock,
}));

vi.mock("@rudderhq/agent-runtime-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rudderhq/agent-runtime-utils/server-utils")>();
  return { ...actual, runChildProcess: runChildProcessMock };
});

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-instruction-snapshot-"));
  executeCodexAppServerChatMock.mockReset();
  runChildProcessMock.mockReset();
  runChildProcessMock.mockResolvedValue({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: null,
    startedAt: null,
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("Codex App Server instruction snapshots", () => {
  it("keeps native user turn input out of the operator-visible instruction stack", async () => {
    const userInputSentinel = "RUDDER_CODEX_CHAT_USER_INPUT_SENTINEL_91f0a7";
    const developerInstructionSentinel = "RUDDER_CODEX_DEVELOPER_INSTRUCTION_SENTINEL_57c1bd";
    vi.stubEnv("RUDDER_HOME", path.join(tempRoot, "rudder-home"));
    vi.stubEnv("RUDDER_INSTANCE_ID", "instruction-snapshot-regression");

    executeCodexAppServerChatMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      stdout: "",
      stderr: "",
      summary: "",
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      sessionId: null,
      sessionParams: null,
      chatDeveloperInstructionsRevision: null,
      providerTurnId: null,
      submissionPhase: "accepted",
      resumed: false,
      clearSession: false,
      providerAuthFailure: false,
    });

    const invocationMeta: Array<Record<string, unknown>> = [];
    await execute({
      runId: "run-instruction-snapshot-regression",
      agent: {
        id: "agent-instruction-snapshot-regression",
        orgId: "org-instruction-snapshot-regression",
        name: "Codex snapshot regression",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: process.execPath,
        cwd: tempRoot,
        chatAppServerEnabled: true,
        promptTemplate: userInputSentinel,
        env: { CODEX_HOME: path.join(tempRoot, "shared-codex-home") },
      },
      context: {
        chatMode: true,
        rudderScene: "chat",
        rudderCodexChatPrompt: {
          version: 1,
          developerInstructions: developerInstructionSentinel,
        },
      },
      onLog: vi.fn(async () => undefined),
      onMeta: async (meta: AgentRuntimeInvocationMeta) => { invocationMeta.push(meta as unknown as Record<string, unknown>); },
    } as any);

    const nativeTurnOptions = executeCodexAppServerChatMock.mock.calls[0]?.[0] as
      | { prompt?: string; chatDeveloperInstructions?: string }
      | undefined;
    expect(nativeTurnOptions?.prompt).toContain(userInputSentinel);
    expect(nativeTurnOptions?.chatDeveloperInstructions).toContain(developerInstructionSentinel);

    expect(invocationMeta).toHaveLength(1);
    const invocation = invocationMeta[0]!;
    const instructionSnapshot = invocation.agentInstructionStack;
    expect(instructionSnapshot).toEqual(expect.stringContaining(developerInstructionSentinel));
    expect(instructionSnapshot).not.toContain(userInputSentinel);
    expect(invocation.prompt).toContain(developerInstructionSentinel);
    expect(JSON.stringify(invocationMeta)).not.toContain(userInputSentinel);
  });
});

describe("Codex CLI fallback instruction snapshots", () => {
  it.each([
    ["App Server disabled", { chatAppServerEnabled: false }],
    ["unsupported App Server argument", { chatAppServerEnabled: true, args: ["--unsupported-provider-option"] }],
  ])("keeps the user turn in provider input and out of persisted metadata when %s", async (_label, fallbackConfig) => {
    const userInputSentinel = "RUDDER_CODEX_CLI_USER_INPUT_SENTINEL_4a20d1";
    const developerInstructionSentinel = "RUDDER_CODEX_CLI_DEVELOPER_INSTRUCTION_SENTINEL_8c3f62";
    vi.stubEnv("RUDDER_HOME", path.join(tempRoot, "rudder-home"));
    vi.stubEnv("RUDDER_INSTANCE_ID", "cli-instruction-snapshot-regression");

    const invocationMeta: Array<Record<string, unknown>> = [];
    await execute({
      runId: "run-cli-instruction-snapshot-regression",
      agent: {
        id: "agent-cli-instruction-snapshot-regression",
        orgId: "org-cli-instruction-snapshot-regression",
        name: "Codex CLI snapshot regression",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: process.execPath,
        cwd: tempRoot,
        promptTemplate: userInputSentinel,
        env: { CODEX_HOME: path.join(tempRoot, "shared-codex-home") },
        ...fallbackConfig,
      },
      context: {
        chatMode: true,
        rudderScene: "chat",
        rudderCodexChatPrompt: {
          version: 1,
          developerInstructions: developerInstructionSentinel,
        },
      },
      onLog: vi.fn(async () => undefined),
      onMeta: async (meta: AgentRuntimeInvocationMeta) => { invocationMeta.push(meta as unknown as Record<string, unknown>); },
    } as any);

    expect(executeCodexAppServerChatMock).not.toHaveBeenCalled();
    const processOptions = runChildProcessMock.mock.calls[0]?.[3] as { stdin?: string } | undefined;
    expect(processOptions?.stdin).toContain(userInputSentinel);
    expect(processOptions?.stdin).toContain(developerInstructionSentinel);

    expect(invocationMeta).toHaveLength(1);
    const invocation = invocationMeta[0]!;
    expect(invocation.prompt).toContain(developerInstructionSentinel);
    expect(invocation.agentInstructionStack).toContain(developerInstructionSentinel);
    expect(invocation.prompt).not.toContain(userInputSentinel);
    expect(invocation.agentInstructionStack).not.toContain(userInputSentinel);
    expect(JSON.stringify(invocationMeta)).not.toContain(userInputSentinel);
  });
});

describe("qualified Chat stdout policy", () => {
  const config = { providerProfileId: "profile-1", env: { CODEX_HOME: "/isolated/profile" }, model: "test" };
  const qualified = {
    runId: "run-1", agent: { orgId: "org-1", agentRuntimeType: "codex_local" }, config,
    context: { chatMode: true, rudderCodexStdoutPolicy: {
      mode: "native_retained", runtimeType: "codex_local", runId: "run-1", orgId: "org-1",
      configSha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    } },
  };
  it("omits only the unchanged positively qualified execution", () => {
    expect(codexChatStdoutCapturePolicy(qualified as any)).toBe("omit");
  });
  it("captures missing, unknown, legacy, scope/profile drift and fallback", () => {
    for (const ctx of [
      { ...qualified, context: { chatMode: true, useAppServerChat: true } },
      ...["unknown", "legacy"].map(mode => ({ ...qualified, context: {
        ...qualified.context, rudderCodexStdoutPolicy: { ...qualified.context.rudderCodexStdoutPolicy, mode },
      } })),
      { ...qualified, runId: "other-run" },
      { ...qualified, agent: { ...qualified.agent, orgId: "other-org" } },
      { ...qualified, config: { ...config, providerProfileId: "other-profile" } },
      { ...qualified, config: { ...config, env: { CODEX_HOME: "/other/home" } } },
      { ...qualified, context: { ...qualified.context, chatMode: false } },
      { ...qualified, context: { ...qualified.context, rudderModelFallback: { attemptIndex: 1 } } },
      { ...qualified, config: { ...config, rudderCodexStdoutPolicy: qualified.context.rudderCodexStdoutPolicy }, context: { chatMode: true } },
    ]) expect(codexChatStdoutCapturePolicy(ctx as any)).toBe("capture");
  });
});

describe("resolveCodexAgentHome", () => {
  const base = {
    configuredAgentHome: "",
    cwd: "/tmp/rudder-product-intelligence",
    runtimeScene: "product_intelligence",
    effectiveCodexHome: "/tmp/rudder/organizations/org-1/codex-home/agents/product-intelligence-lightweight",
    agentId: "product-intelligence-lightweight",
  };

  it("keeps product intelligence in its temporary cwd", () => {
    expect(resolveCodexAgentHome(base)).toBe("/tmp/rudder-product-intelligence");
  });

  it("preserves an explicitly configured agent home", () => {
    expect(resolveCodexAgentHome({
      ...base,
      configuredAgentHome: "/tmp/explicit-agent-home",
    })).toBe("/tmp/explicit-agent-home");
  });

  it("keeps the persisted agent fallback for normal runs", () => {
    expect(resolveCodexAgentHome({
      ...base,
      runtimeScene: "heartbeat",
    })).toBe("/tmp/rudder/organizations/org-1/workspaces/agents/product-intelligence-lightweight");
  });
});

describe("buildCodexSessionParams", () => {
  it("keeps only provider-native thread metadata returned by App Server", () => {
    expect(buildCodexSessionParams({
      sessionId: "thread-1",
      cwd: "/tmp/workspace",
      native: {
        threadId: "thread-1",
        rootSessionId: "root-1",
        forkedFromId: "parent-1",
        model: "gpt-test",
        modelProvider: "openai",
        ephemeral: false,
        cwd: "/provider/cwd",
        secret: "must-not-persist",
      },
      workspaceId: "workspace-1",
      repoUrl: "https://example.test/repo.git",
      repoRef: "main",
      profile: {
        profileHostId: "local",
        profileId: "codex-profile",
        capabilityRevision: "cap-1",
      },
      chatDeveloperInstructionsRevision: "sha256-revision-1",
    })).toEqual({
      threadId: "thread-1",
      rootSessionId: "root-1",
      forkedFromId: "parent-1",
      model: "gpt-test",
      modelProvider: "openai",
      ephemeral: false,
      sessionId: "thread-1",
      cwd: "/tmp/workspace",
      workspaceId: "workspace-1",
      repoUrl: "https://example.test/repo.git",
      repoRef: "main",
      rudderChatDeveloperInstructionsRevision: "sha256-revision-1",
      profileHostId: "local",
      profileId: "codex-profile",
      capabilityRevision: "cap-1",
    });
  });

  it("does not create provider state when the transport returned no session identity", () => {
    expect(buildCodexSessionParams({ sessionId: null, cwd: "/tmp/workspace" })).toBeNull();
  });
});

describe("validateCodexResumeSession", () => {
  const profile = {
    profileHostId: "host-1",
    profileId: "profile-1",
    profileBindingId: "binding-1",
    profileOrgId: "org-1",
    workspaceBindingId: "workspace-binding-1",
    capabilityRevision: "rev-1",
  };
  const base = {
    sessionId: "thread-1",
    cwd: "/tmp/workspace",
    expectedTransport: "codex_app_server" as const,
    workspaceId: "workspace-1",
    repoUrl: "https://example.test/repo.git",
    repoRef: "main",
    profile,
  };

  const resumeDriftCases: Array<[
    string,
    { cwd?: string; sessionParams?: Record<string, string> },
  ]> = [
    ["cwd", { cwd: "/tmp/other" }],
    ["host", { sessionParams: { profileHostId: "other-host" } }],
    ["profile", { sessionParams: { profileId: "other-profile" } }],
    ["transport", { sessionParams: { transport: "codex_cli" } }],
    ["workspace", { sessionParams: { workspaceId: "other-workspace" } }],
  ];

  it.each(resumeDriftCases)("rejects %s drift without permitting a fresh session", (_label, override) => {
    const input = {
      ...base,
      sessionParams: {
        sessionId: "thread-1",
        cwd: "/tmp/workspace",
        transport: "codex_app_server",
        ...override.sessionParams,
      },
      ...(override.cwd ? { cwd: override.cwd } : {}),
    };
    expect(validateCodexResumeSession(input)).toMatch(/does not match|drift|identity|transport/u);
  });

  it("accepts a fully bound resume", () => {
    expect(validateCodexResumeSession({
      ...base,
      sessionParams: {
        sessionId: "thread-1",
        cwd: "/tmp/workspace",
        transport: "codex_app_server",
        profileHostId: "host-1",
        profileId: "profile-1",
        profileBindingId: "binding-1",
        profileOrgId: "org-1",
        workspaceBindingId: "workspace-binding-1",
        capabilityRevision: "rev-1",
        workspaceId: "workspace-1",
        repoUrl: "https://example.test/repo.git",
        repoRef: "main",
      },
    })).toBeNull();
  });
});

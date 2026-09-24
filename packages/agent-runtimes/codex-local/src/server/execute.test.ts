import { describe, expect, it } from "vitest";
import { buildCodexSessionParams, resolveCodexAgentHome, validateCodexResumeSession } from "./execute.js";

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

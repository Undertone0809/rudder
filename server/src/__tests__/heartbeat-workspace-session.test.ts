import { describe, expect, it } from "vitest";
import type { agents } from "@rudder/db";
import { sessionCodec as codexSessionCodec } from "@rudder/agent-runtime-codex-local/server";
import { buildAgentWorkspaceKey } from "../agent-workspace-key.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  buildExplicitResumeSessionOverride,
  formatRuntimeWorkspaceWarningLog,
  prioritizeProjectWorkspaceCandidatesForRun,
  parseSessionCompactionPolicy,
  resolveRuntimeSessionParamsForWorkspace,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";

function buildResolvedWorkspace(overrides: Partial<ResolvedWorkspaceForRun> = {}): ResolvedWorkspaceForRun {
  return {
    cwd: "/tmp/agent-workspace",
    source: "agent_home",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: null,
    workspaceHints: [],
    warnings: [],
    ...overrides,
  };
}

function buildAgent(agentRuntimeType: string, runtimeConfig: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    orgId: "organization-1",
    projectId: null,
    goalId: null,
    name: "Agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "running",
    reportsTo: null,
    capabilities: null,
    agentRuntimeType,
    agentRuntimeConfig: {},
    runtimeConfig,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as typeof agents.$inferSelect;
}

describe("resolveRuntimeSessionParamsForWorkspace", () => {
  it("migrates saved project workspace sessions to the canonical agent workspace", () => {
    const agent = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Agent Builder",
      workspaceKey: buildAgentWorkspaceKey("Agent Builder", "11111111-1111-4111-8111-111111111111"),
    };
    const canonicalAgentCwd = resolveDefaultAgentWorkspaceDir("organization-1", agent);

    const result = resolveRuntimeSessionParamsForWorkspace({
      orgId: "organization-1",
      agent,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: "/tmp/previous-project-cwd",
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: canonicalAgentCwd }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: canonicalAgentCwd,
      workspaceId: "workspace-1",
    });
    expect(result.warning).toContain("canonical run workspace");
  });

  it("does not migrate when the session is already on the canonical agent workspace", () => {
    const agent = {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Agent Builder",
      workspaceKey: buildAgentWorkspaceKey("Agent Builder", "22222222-2222-4222-8222-222222222222"),
    };
    const canonicalAgentCwd = resolveDefaultAgentWorkspaceDir("organization-1", agent);

    const result = resolveRuntimeSessionParamsForWorkspace({
      orgId: "organization-1",
      agent,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: canonicalAgentCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: canonicalAgentCwd }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: canonicalAgentCwd,
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });

  it("keeps the previous workspace metadata when the resolved workspace id differs", () => {
    const agent = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Agent Builder",
      workspaceKey: buildAgentWorkspaceKey("Agent Builder", "33333333-3333-4333-8333-333333333333"),
    };
    const canonicalAgentCwd = resolveDefaultAgentWorkspaceDir("organization-1", agent);

    const result = resolveRuntimeSessionParamsForWorkspace({
      orgId: "organization-1",
      agent,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: "/tmp/previous-project-cwd",
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: canonicalAgentCwd,
        workspaceId: "workspace-2",
      }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: canonicalAgentCwd,
      workspaceId: "workspace-1",
    });
    expect(result.warning).toContain("canonical run workspace");
  });

  it("attaches the canonical agent workspace when the saved session has no cwd", () => {
    const agent = {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Agent Builder",
      workspaceKey: buildAgentWorkspaceKey("Agent Builder", "44444444-4444-4444-8444-444444444444"),
    };
    const canonicalAgentCwd = resolveDefaultAgentWorkspaceDir("organization-1", agent);

    const result = resolveRuntimeSessionParamsForWorkspace({
      orgId: "organization-1",
      agent,
      previousSessionParams: {
        sessionId: "session-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: canonicalAgentCwd }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: canonicalAgentCwd,
    });
    expect(result.warning).toContain("canonical run workspace");
  });

  it("copies resolved workspace metadata when migrating a session without saved workspace metadata", () => {
    const agent = {
      id: "55555555-5555-4555-8555-555555555555",
      name: "Agent Builder",
      workspaceKey: buildAgentWorkspaceKey("Agent Builder", "55555555-5555-4555-8555-555555555555"),
    };
    const canonicalAgentCwd = resolveDefaultAgentWorkspaceDir("organization-1", agent);

    const result = resolveRuntimeSessionParamsForWorkspace({
      orgId: "organization-1",
      agent,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: "/tmp/previous-project-cwd",
      },
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: canonicalAgentCwd,
        workspaceId: "workspace-9",
        repoUrl: "https://example.com/repo.git",
        repoRef: "main",
      }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: canonicalAgentCwd,
      workspaceId: "workspace-9",
      repoUrl: "https://example.com/repo.git",
      repoRef: "main",
    });
    expect(result.warning).toContain("canonical run workspace");
  });
});

describe("shouldResetTaskSessionForWake", () => {
  it("resets session context on assignment wake", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("preserves session context on timer heartbeats", () => {
    expect(shouldResetTaskSessionForWake({ wakeSource: "timer" })).toBe(false);
  });

  it("preserves session context on manual on-demand invokes by default", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
      }),
    ).toBe(false);
  });

  it("resets session context when a fresh session is explicitly requested", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
        forceFreshSession: true,
      }),
    ).toBe(true);
  });

  it("does not reset session context on mention wake comment", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      }),
    ).toBe(false);
  });

  it("does not reset session context when commentId is present", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_commented",
        commentId: "comment-2",
      }),
    ).toBe(false);
  });

  it("does not reset for comment wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("does not reset when wake reason is missing", () => {
    expect(shouldResetTaskSessionForWake({})).toBe(false);
  });

  it("does not reset session context on callback on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "callback",
      }),
    ).toBe(false);
  });
});

describe("buildExplicitResumeSessionOverride", () => {
  it("reuses saved task session params when they belong to the selected failed run", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "session-after",
          cwd: "/tmp/project",
        },
        sessionDisplayId: "session-after",
        lastRunId: "run-1",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
        cwd: "/tmp/project",
      },
    });
  });

  it("falls back to the selected run session id when no matching task session params are available", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "other-session",
          cwd: "/tmp/project",
        },
        sessionDisplayId: "other-session",
        lastRunId: "run-2",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
      },
    });
  });

  it("reuses saved task session params when the saved display id matches the selected run", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "session-after",
          cwd: "/tmp/project",
          workspaceId: "workspace-1",
        },
        sessionDisplayId: "session-after",
        lastRunId: "run-2",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
        cwd: "/tmp/project",
        workspaceId: "workspace-1",
      },
    });
  });
});

describe("formatRuntimeWorkspaceWarningLog", () => {
  it("emits informational workspace warnings on stdout", () => {
    expect(formatRuntimeWorkspaceWarningLog("Run will start in canonical agent workspace")).toEqual({
      stream: "stdout",
      chunk: "[rudder] Run will start in canonical agent workspace\n",
    });
  });
});

describe("prioritizeProjectWorkspaceCandidatesForRun", () => {
  it("moves the explicitly selected workspace to the front", () => {
    const rows = [
      { id: "workspace-1", cwd: "/tmp/one" },
      { id: "workspace-2", cwd: "/tmp/two" },
      { id: "workspace-3", cwd: "/tmp/three" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-2").map((row) => row.id),
    ).toEqual(["workspace-2", "workspace-1", "workspace-3"]);
  });

  it("keeps the original order when no preferred workspace is selected", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, null).map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });

  it("keeps the original order when the selected workspace is missing", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-9").map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });
});

describe("parseSessionCompactionPolicy", () => {
  it("disables Rudder-managed rotation by default for codex and claude local", () => {
    expect(parseSessionCompactionPolicy(buildAgent("codex_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
    expect(parseSessionCompactionPolicy(buildAgent("claude_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
  });

  it("keeps conservative defaults for adapters without confirmed native compaction", () => {
    expect(parseSessionCompactionPolicy(buildAgent("cursor"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
    expect(parseSessionCompactionPolicy(buildAgent("opencode_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
  });

  it("lets explicit agent overrides win over adapter defaults", () => {
    expect(
      parseSessionCompactionPolicy(
        buildAgent("codex_local", {
          heartbeat: {
            sessionCompaction: {
              maxSessionRuns: 25,
              maxRawInputTokens: 500_000,
            },
          },
        }),
      ),
    ).toEqual({
      enabled: true,
      maxSessionRuns: 25,
      maxRawInputTokens: 500_000,
      maxSessionAgeHours: 0,
    });
  });
});

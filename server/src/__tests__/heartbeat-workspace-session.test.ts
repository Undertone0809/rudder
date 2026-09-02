import { sessionCodec as codexSessionCodec } from "@rudderhq/agent-runtime-codex-local/server";
import type { agents } from "@rudderhq/db";
import { describe, expect, it, vi } from "vitest";
import { buildAgentWorkspaceKey } from "../agent-workspace-key.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  buildExplicitResumeSessionOverride,
  formatRuntimeWorkspaceWarningLog,
  parseSessionCompactionPolicy,
  prioritizeProjectWorkspaceCandidatesForRun,
  resolveRuntimeSessionParamsForWorkspace,
  selectRunSessionLineage,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";
import { hydrateWakeContextSnapshot } from "../services/runtime-kernel/heartbeat.sessions.ts";

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
    expect(result.warning).toContain("canonical run directory");
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
    expect(result.warning).toContain("canonical run directory");
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
    expect(result.warning).toContain("canonical run directory");
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
    expect(result.warning).toContain("canonical run directory");
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

describe("hydrateWakeContextSnapshot", () => {
  it("hydrates explicit issue owner, reviewer, status, and timestamps for agent prompts", async () => {
    const issueRows = [
      {
        id: "issue-1",
        title: "Clarify prompt metadata",
        description: "Show all routing metadata in the agent prompt.",
        status: "blocked",
        priority: "high",
        goalId: "goal-1",
        projectId: "project-1",
        assigneeAgentId: "agent-assignee",
        assigneeAgentName: "Wesley",
        assigneeUserId: null,
        assigneeUserName: null,
        reviewerAgentId: null,
        reviewerAgentName: null,
        reviewerUserId: "user-reviewer",
        reviewerUserName: "Holden",
        createdAt: new Date("2026-06-19T08:15:00.000Z"),
        updatedAt: new Date("2026-06-19T10:30:00.000Z"),
      },
    ];
    const agentRows = [{ id: "agent-assignee", name: "Wesley" }];
    const userRows = [{ id: "user-reviewer", name: "Holden" }];
    const issueWhere = vi.fn(async () => issueRows);
    const agentWhere = vi.fn(async () => agentRows);
    const userWhere = vi.fn(async () => userRows);
    const db = {
      select: vi.fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: issueWhere })) })
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: agentWhere })) })
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: userWhere })) }),
    } as any;
    const contextSnapshot: Record<string, unknown> = { issueId: "issue-1" };

    await hydrateWakeContextSnapshot(db, "org-1", contextSnapshot);

    expect(contextSnapshot.projectId).toBe("project-1");
    expect(contextSnapshot.goalId).toBe("goal-1");
    expect(contextSnapshot.issue).toMatchObject({
      id: "issue-1",
      title: "Clarify prompt metadata",
      description: "Show all routing metadata in the agent prompt.",
      status: "blocked",
      priority: "high",
      assigneeAgentId: "agent-assignee",
      assigneeUserId: null,
      assigneeLabel: "Wesley (agent)",
      reviewerAgentId: null,
      reviewerUserId: "user-reviewer",
      reviewerLabel: "Holden (user)",
      createdAt: "2026-06-19T08:15:00.000Z",
      updatedAt: "2026-06-19T10:30:00.000Z",
    });
  });

  it("refreshes stale issue metadata and marks empty assignee and reviewer as none", async () => {
    const issueRows = [
      {
        id: "issue-2",
        title: "Current prompt metadata",
        description: "Use current DB state.",
        status: "in_review",
        priority: "medium",
        projectId: null,
        assigneeAgentId: null,
        assigneeUserId: null,
        reviewerAgentId: null,
        reviewerUserId: null,
        createdAt: new Date("2026-06-19T09:00:00.000Z"),
        updatedAt: new Date("2026-06-19T11:00:00.000Z"),
      },
    ];
    const issueWhere = vi.fn(async () => issueRows);
    const db = {
      select: vi.fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: issueWhere })) }),
    } as any;
    const contextSnapshot: Record<string, unknown> = {
      issueId: "issue-2",
      issue: {
        id: "issue-2",
        title: "Stale prompt metadata",
        description: "Old description.",
        status: "todo",
        priority: "low",
        assigneeAgentId: "old-agent",
        assigneeUserId: null,
        assigneeLabel: "Old Agent (agent)",
        reviewerAgentId: "old-reviewer",
        reviewerUserId: null,
        reviewerLabel: "Old Reviewer (agent)",
        createdAt: "2026-06-18T09:00:00.000Z",
        updatedAt: "2026-06-18T11:00:00.000Z",
      },
    };

    await hydrateWakeContextSnapshot(db, "org-1", contextSnapshot);

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(contextSnapshot.issue).toMatchObject({
      id: "issue-2",
      title: "Current prompt metadata",
      description: "Use current DB state.",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      assigneeLabel: "none",
      reviewerAgentId: null,
      reviewerUserId: null,
      reviewerLabel: "none",
      createdAt: "2026-06-19T09:00:00.000Z",
      updatedAt: "2026-06-19T11:00:00.000Z",
    });
  });
});

describe("buildExplicitResumeSessionOverride", () => {
  it("falls back from invalid after params to valid before params", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "invalid-after",
      resumeRunSessionParamsBefore: { sessionId: "session-before", cwd: "/tmp/before" },
      resumeRunSessionParamsAfter: {},
      taskSession: null,
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-before",
      sessionParams: { sessionId: "session-before", cwd: "/tmp/before" },
    });
  });

  it("uses explicit context params when a recovery run failed before column persistence", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "retry-run",
      resumeRunSessionIdBefore: "source-session",
      resumeRunSessionIdAfter: null,
      resumeContextSessionParams: { sessionId: "source-session", cwd: "/tmp/source" },
      resumeContextSessionDisplayId: "source-session",
      taskSession: null,
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "source-session",
      sessionParams: { sessionId: "source-session", cwd: "/tmp/source" },
    });
  });

  it("does not resume a source run that explicitly cleared its session", () => {
    expect(buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "stale-session",
      resumeRunSessionIdAfter: null,
      resumeRunSessionParamsBefore: { sessionId: "stale-session" },
      resumeRunSessionParamsAfter: {},
      resumeRunSessionCleared: true,
      taskSession: null,
      sessionCodec: codexSessionCodec,
    })).toEqual({
      sessionDisplayId: null,
      sessionParams: null,
      sessionCleared: true,
      sessionReuseSuppression: {
        kind: "source_session_cleared",
        sourceRunId: "run-1",
      },
    });
  });

  it("prefers session params persisted on the selected source run", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      resumeRunSessionParamsBefore: {
        sessionId: "session-before",
        cwd: "/tmp/before",
      },
      resumeRunSessionParamsAfter: {
        sessionId: "session-after",
        cwd: "/tmp/selected-run",
      },
      taskSession: {
        sessionParamsJson: {
          sessionId: "session-after",
          cwd: "/tmp/newer-global-state",
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
        cwd: "/tmp/selected-run",
      },
    });
  });

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

describe("selectRunSessionLineage", () => {
  it("starts ordinary taskless runs fresh", () => {
    expect(selectRunSessionLineage({
      forceFresh: false,
      explicitSessionParams: null,
      explicitSessionDisplayId: null,
      taskSessionParams: null,
      taskSessionDisplayId: null,
    })).toEqual({
      reuseScope: "none",
      sessionParams: null,
      sessionDisplayId: null,
    });
  });

  it("reuses a saved task session when no explicit lineage exists", () => {
    expect(selectRunSessionLineage({
      forceFresh: false,
      explicitSessionParams: null,
      explicitSessionDisplayId: null,
      taskSessionParams: { sessionId: "task-session", cwd: "/tmp/task" },
      taskSessionDisplayId: "task-session",
    })).toEqual({
      reuseScope: "task",
      sessionParams: { sessionId: "task-session", cwd: "/tmp/task" },
      sessionDisplayId: "task-session",
    });
  });

  it("prefers explicit retry lineage over a newer task session", () => {
    expect(selectRunSessionLineage({
      forceFresh: false,
      explicitSessionParams: { sessionId: "selected-run", cwd: "/tmp/selected" },
      explicitSessionDisplayId: "selected-run",
      taskSessionParams: { sessionId: "newer-task", cwd: "/tmp/newer" },
      taskSessionDisplayId: "newer-task",
    })).toEqual({
      reuseScope: "explicit",
      sessionParams: { sessionId: "selected-run", cwd: "/tmp/selected" },
      sessionDisplayId: "selected-run",
    });
  });

  it("lets forceFresh override explicit and task lineage", () => {
    expect(selectRunSessionLineage({
      forceFresh: true,
      explicitSessionParams: { sessionId: "selected-run" },
      explicitSessionDisplayId: "selected-run",
      taskSessionParams: { sessionId: "task-session" },
      taskSessionDisplayId: "task-session",
    })).toEqual({
      reuseScope: "none",
      sessionParams: null,
      sessionDisplayId: null,
    });
  });

  it("preserves explicit lineage when an assignment reset suppresses the task candidate", () => {
    expect(selectRunSessionLineage({
      forceFresh: false,
      explicitSessionParams: { sessionId: "retry-session" },
      explicitSessionDisplayId: "retry-session",
      taskSessionParams: null,
      taskSessionDisplayId: null,
    })).toEqual({
      reuseScope: "explicit",
      sessionParams: { sessionId: "retry-session" },
      sessionDisplayId: "retry-session",
    });
  });
});

describe("formatRuntimeWorkspaceWarningLog", () => {
  it("emits informational workspace warnings on stdout", () => {
    expect(formatRuntimeWorkspaceWarningLog("Run will start in canonical agent directory")).toEqual({
      stream: "stdout",
      chunk: "[rudder] Run will start in canonical agent directory\n",
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

import { describe, expect, it } from "vitest";
import type { Agent, Approval } from "@rudderhq/shared";
import {
  appendCreateAgentBenchmarkMetadata,
  buildCreateAgentBenchmarkMetadata,
  createAgentEvalCheckToScoreValue,
  evaluateCreateAgentBenchmark,
  extractCreateAgentBenchmarkMetadata,
  parseCreateAgentCase,
} from "./create-agent-benchmark.js";
import type { ObservedRunDetail } from "./types.js";

function makeRunDetail(status: ObservedRunDetail["run"]["status"] = "succeeded"): ObservedRunDetail {
  return {
    run: {
      id: "run-1",
      orgId: "org-1",
      agentId: "agent-bench",
      invocationSource: "assignment",
      triggerDetail: "system",
      status,
      startedAt: new Date("2026-04-14T00:00:00.000Z"),
      finishedAt: new Date("2026-04-14T00:01:00.000Z"),
      error: null,
      wakeupRequestId: null,
      exitCode: 0,
      signal: null,
      usageJson: null,
      resultJson: null,
      sessionIdBefore: null,
      sessionIdAfter: null,
      logStore: null,
      logRef: null,
      logBytes: null,
      logSha256: null,
      logCompressed: false,
      stdoutExcerpt: null,
      stderrExcerpt: null,
      errorCode: null,
      externalRunId: null,
      processPid: null,
      processStartedAt: null,
      retryOfRunId: null,
      processLossRetryCount: 0,
      contextSnapshot: { issueId: "issue-1" },
      createdAt: new Date("2026-04-14T00:00:00.000Z"),
      updatedAt: new Date("2026-04-14T00:01:00.000Z"),
    },
    agentName: "Benchmark Agent",
    orgName: "Rudder",
    issue: {
      id: "issue-1",
      identifier: "RUD-1",
      title: "Create a CTO agent",
    },
    bundle: {
      agentRuntimeType: "codex_local",
      agentConfigRevisionId: null,
      agentConfigRevisionCreatedAt: null,
      agentConfigFingerprint: null,
      runtimeConfigFingerprint: null,
    },
    langfuse: null,
    events: [],
    logContent: null,
    logChunks: [],
    transcript: [
      {
        kind: "assistant",
        ts: "2026-04-14T00:00:10.000Z",
        text: "I created the CTO agent and linked the issue.",
        delta: false,
      },
      {
        kind: "result",
        ts: "2026-04-14T00:00:50.000Z",
        text: "Created CTO",
        errors: [],
        subtype: "success",
        inputTokens: 12,
        outputTokens: 18,
        cachedTokens: 0,
        costUsd: 0.01,
        isError: false,
      },
    ],
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-new",
    orgId: "org-1",
    name: "CTO",
    urlKey: "cto",
    role: "cto",
    title: "Chief Technology Officer",
    icon: "crown",
    status: "idle",
    reportsTo: "agent-ceo",
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-14T00:00:20.000Z"),
    updatedAt: new Date("2026-04-14T00:00:20.000Z"),
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    orgId: "org-1",
    type: "hire_agent",
    requestedByAgentId: "agent-bench",
    requestedByUserId: null,
    status: "pending",
    payload: { agentId: "agent-new" },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-04-14T00:00:20.000Z"),
    updatedAt: new Date("2026-04-14T00:00:20.000Z"),
    ...overrides,
  };
}

describe("create-agent benchmark helpers", () => {
  it("parses valid benchmark cases", () => {
    expect(parseCreateAgentCase({
      id: "approval-cto",
      prompt: "Create a CTO agent that reports to the CEO.",
      expectedPath: "approval_required",
      expectedAgentShape: {
        role: "cto",
        title: "Chief Technology Officer",
        reportsToFixture: "ceo",
        agentRuntimeType: "codex_local",
        desiredSkills: ["rudder/rudder-create-agent"],
        sourceIssueRequired: true,
      },
      fixtures: {
        requiredApproval: true,
        requiredFixtureKeys: ["ceo"],
      },
      judgeFocus: ["governance judgment"],
    })).toMatchObject({
      id: "approval-cto",
      expectedPath: "approval_required",
      expectedAgentShape: {
        role: "cto",
        reportsToFixture: "ceo",
      },
    });
  });

  it("round-trips benchmark metadata in issue descriptions", () => {
    const metadata = buildCreateAgentBenchmarkMetadata({
      testCase: parseCreateAgentCase({
        id: "direct-engineer",
        prompt: "Create an engineer",
        expectedPath: "direct_create",
        expectedAgentShape: {
          role: "engineer",
        },
      }),
      judgeVersion: "langfuse:judge-create-agent@production",
    });
    const description = appendCreateAgentBenchmarkMetadata("Create an engineer", metadata);
    expect(extractCreateAgentBenchmarkMetadata(description)).toEqual(metadata);
  });

  it("evaluates approval-required cases with deterministic pass signals", () => {
    const testCase = parseCreateAgentCase({
      id: "approval-cto",
      prompt: "Create a CTO agent that reports to the CEO.",
      expectedPath: "approval_required",
      expectedAgentShape: {
        name: "CTO",
        role: "cto",
        title: "Chief Technology Officer",
        reportsToFixture: "ceo",
        agentRuntimeType: "codex_local",
        desiredSkills: ["rudder/rudder-create-agent"],
        sourceIssueRequired: true,
      },
    });
    const benchmarkMetadata = buildCreateAgentBenchmarkMetadata({ testCase, judgeVersion: null });
    const result = evaluateCreateAgentBenchmark({
      testCase,
      benchmarkMetadata,
      issueId: "issue-1",
      runDetail: makeRunDetail(),
      createdAgents: [
        {
          agent: makeAgent({ status: "pending_approval" }),
          skills: {
            agentRuntimeType: "codex_local",
            supported: true,
            mode: "persistent",
            desiredSkills: ["rudder/rudder-create-agent"],
            entries: [],
            warnings: [],
          },
        },
      ],
      createdApprovals: [
        {
          approval: makeApproval(),
          issueIds: ["issue-1"],
        },
      ],
      fixtureRefs: { ceo: "agent-ceo" },
      judge: {
        status: "completed",
        version: "judge-v1",
        summary: "Configuration quality is solid.",
        configQuality: 5,
        reasoningQuality: 4,
        governanceJudgmentQuality: 5,
      },
    });

    expect(result.checks.create_agent_path_correct.value).toBe("pass");
    expect(result.checks.create_agent_reports_to_valid.value).toBe("pass");
    expect(result.checks.create_agent_skills_valid.value).toBe("pass");
    expect(result.checks.create_agent_overall_correctness.value).toBe("pass");
    expect(result.finalClassification).toBe("pass");
    expect(createAgentEvalCheckToScoreValue(result.checks.create_agent_overall_correctness)).toBe(true);
  });

  it("flags filesystem fallback and failed overall correctness", () => {
    const testCase = parseCreateAgentCase({
      id: "direct-engineer",
      prompt: "Create an engineer",
      expectedPath: "direct_create",
      expectedAgentShape: {
        role: "engineer",
      },
    });
    const detail = makeRunDetail();
    detail.logContent = "mkdir .agents/agents/Engineer\nwrote SKILL.md";

    const result = evaluateCreateAgentBenchmark({
      testCase,
      benchmarkMetadata: buildCreateAgentBenchmarkMetadata({ testCase, judgeVersion: null }),
      issueId: "issue-1",
      runDetail: detail,
      createdAgents: [],
      createdApprovals: [],
      judge: null,
    });

    expect(result.checks.create_agent_no_filesystem_fallback.value).toBe("fail");
    expect(result.checks.create_agent_overall_correctness.value).toBe("fail");
    expect(result.finalClassification).toBe("fail");
  });

  it("keeps partial side effects observable when the run is still in progress", () => {
    const testCase = parseCreateAgentCase({
      id: "direct-engineer",
      prompt: "Create an engineer",
      expectedPath: "direct_create",
      expectedAgentShape: {
        role: "engineer",
        title: "Senior Engineer",
        agentRuntimeType: "codex_local",
      },
    });
    const detail = makeRunDetail("running");

    const result = evaluateCreateAgentBenchmark({
      testCase,
      benchmarkMetadata: buildCreateAgentBenchmarkMetadata({ testCase, judgeVersion: null }),
      issueId: "issue-1",
      runDetail: detail,
      createdAgents: [
        {
          agent: makeAgent({
            role: "engineer",
            title: "Senior Engineer",
            agentRuntimeType: "codex_local",
          }),
          skills: {
            agentRuntimeType: "codex_local",
            supported: true,
            mode: "persistent",
            desiredSkills: [],
            entries: [],
            warnings: [],
          },
        },
      ],
      createdApprovals: [],
      judge: null,
    });

    expect(result.checks.create_agent_request_completed.value).toBe("pass");
    expect(result.finalClassification).toBe("needs_review");
    expect(result.reviewReasons).toContain("run_incomplete:running");
  });
});

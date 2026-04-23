import type { Agent, Approval, AgentSkillSnapshot } from "@rudder/shared";
import { buildObservedRunTrace, previewTextForTranscriptEntry } from "./trace.js";
import type { ObservedRunDetail } from "./types.js";

export const CREATE_AGENT_BENCHMARK_MARKER = "rudder-create-agent-benchmark";
export const CREATE_AGENT_EVALUATION_VERSION = "create-agent-eval-v1";
export const CREATE_AGENT_LOCAL_JUDGE_VERSION = "local:create-agent-judge-v1";

export type CreateAgentExpectedPath = "direct_create" | "approval_required" | "reject_or_escalate";
export type CreateAgentEvalCheckValue = "pass" | "fail" | "uncertain" | "not_applicable";
export type CreateAgentFinalClassification = "pass" | "fail" | "needs_review";
export type CreateAgentReviewerStatus = "not_required" | "pending";

export interface CreateAgentExpectedAgentShape {
  name?: string;
  role?: string;
  title?: string | null;
  reportsTo?: string | null;
  reportsToFixture?: string | null;
  agentRuntimeType?: string;
  desiredSkills?: string[];
  sourceIssueRequired?: boolean;
}

export interface CreateAgentCase {
  id: string;
  prompt: string;
  expectedPath: CreateAgentExpectedPath;
  expectedAgentShape: CreateAgentExpectedAgentShape;
  fixtures?: {
    requiredApproval?: boolean | null;
    requiredFixtureKeys?: string[];
  };
  judgeFocus?: string[];
}

export interface CreateAgentBenchmarkMetadata {
  workflow: "create-agent";
  benchmark: true;
  benchmarkCaseId: string;
  expectedPath: CreateAgentExpectedPath;
  requestedRole: string | null;
  requestedRuntimeType: string | null;
  evaluationVersion: string;
  judgeVersion: string | null;
}

export interface CreateAgentCapturedAgent {
  agent: Agent;
  skills: AgentSkillSnapshot | null;
}

export interface CreateAgentCapturedApproval {
  approval: Approval;
  issueIds: string[];
}

export interface CreateAgentEvalCheck {
  value: CreateAgentEvalCheckValue;
  comment: string;
  metadata?: Record<string, unknown>;
}

export interface CreateAgentJudgeResult {
  status: "completed" | "skipped" | "failed";
  version: string;
  summary: string | null;
  configQuality: number | null;
  reasoningQuality: number | null;
  governanceJudgmentQuality: number | null;
  error?: string | null;
}

export interface CreateAgentEvalResult {
  evaluationVersion: string;
  benchmarkMetadata: CreateAgentBenchmarkMetadata;
  issueId: string | null;
  runId: string;
  runStatus: string;
  checks: {
    create_agent_request_completed: CreateAgentEvalCheck;
    create_agent_path_correct: CreateAgentEvalCheck;
    create_agent_payload_valid: CreateAgentEvalCheck;
    create_agent_reports_to_valid: CreateAgentEvalCheck;
    create_agent_runtime_valid: CreateAgentEvalCheck;
    create_agent_skills_valid: CreateAgentEvalCheck;
    create_agent_source_issue_linked: CreateAgentEvalCheck;
    create_agent_no_filesystem_fallback: CreateAgentEvalCheck;
    create_agent_overall_correctness: CreateAgentEvalCheck;
  };
  judge: CreateAgentJudgeResult | null;
  finalClassification: CreateAgentFinalClassification;
  reviewerStatus: CreateAgentReviewerStatus;
  shouldQueueForReview: boolean;
  reviewReasons: string[];
  finalOutputSummary: string;
  filesystemFallbackMatches: string[];
  createdAgents: CreateAgentCapturedAgent[];
  createdApprovals: CreateAgentCapturedApproval[];
}

export interface EvaluateCreateAgentBenchmarkInput {
  testCase: CreateAgentCase;
  runDetail: ObservedRunDetail;
  createdAgents: CreateAgentCapturedAgent[];
  createdApprovals: CreateAgentCapturedApproval[];
  issueId: string | null;
  benchmarkMetadata: CreateAgentBenchmarkMetadata;
  judge: CreateAgentJudgeResult | null;
}

const FALLBACK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bmkdir\b.*\.agents\//i, label: "mkdir .agents path" },
  { pattern: /\b(create|write|save).*(SKILL\.md|COMPANY\.md|instructions? file)/i, label: "local instructions write" },
  { pattern: /create agent director(y|ies)|local agent director(y|ies)/i, label: "local agent directory fallback" },
  { pattern: /\.agents\/skills\/|server\/resources\/bundled-skills\/rudder-create-agent/i, label: "manual skill file browsing" },
];
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => nonEmptyString(item)).filter((item): item is string => Boolean(item));
}

export function parseCreateAgentCase(raw: unknown): CreateAgentCase {
  if (!raw || typeof raw !== "object") {
    throw new Error("Create-agent benchmark case must be an object.");
  }

  const value = raw as Record<string, unknown>;
  const id = nonEmptyString(value.id);
  const prompt = nonEmptyString(value.prompt);
  const expectedPath = nonEmptyString(value.expectedPath);

  if (!id) throw new Error("Create-agent benchmark case is missing a non-empty id.");
  if (!prompt) throw new Error(`Case ${id} is missing a non-empty prompt.`);
  if (expectedPath !== "direct_create" && expectedPath !== "approval_required" && expectedPath !== "reject_or_escalate") {
    throw new Error(`Case ${id} has invalid expectedPath: ${String(value.expectedPath)}`);
  }

  const expectedAgentShape = (value.expectedAgentShape ?? {}) as Record<string, unknown>;
  if (!expectedAgentShape || typeof expectedAgentShape !== "object" || Array.isArray(expectedAgentShape)) {
    throw new Error(`Case ${id} has invalid expectedAgentShape.`);
  }

  const fixtures = (value.fixtures ?? {}) as Record<string, unknown>;
  if (fixtures && (typeof fixtures !== "object" || Array.isArray(fixtures))) {
    throw new Error(`Case ${id} has invalid fixtures.`);
  }

  return {
    id,
    prompt,
    expectedPath,
    expectedAgentShape: {
      name: nonEmptyString(expectedAgentShape.name) ?? undefined,
      role: nonEmptyString(expectedAgentShape.role) ?? undefined,
      title: expectedAgentShape.title === null ? null : nonEmptyString(expectedAgentShape.title) ?? undefined,
      reportsTo: expectedAgentShape.reportsTo === null ? null : nonEmptyString(expectedAgentShape.reportsTo) ?? undefined,
      reportsToFixture: expectedAgentShape.reportsToFixture === null
        ? null
        : nonEmptyString(expectedAgentShape.reportsToFixture) ?? undefined,
      agentRuntimeType: nonEmptyString(expectedAgentShape.agentRuntimeType) ?? undefined,
      desiredSkills: toStringArray(expectedAgentShape.desiredSkills),
      sourceIssueRequired: typeof expectedAgentShape.sourceIssueRequired === "boolean"
        ? expectedAgentShape.sourceIssueRequired
        : undefined,
    },
    fixtures: {
      requiredApproval: typeof fixtures.requiredApproval === "boolean" ? fixtures.requiredApproval : null,
      requiredFixtureKeys: toStringArray(fixtures.requiredFixtureKeys),
    },
    judgeFocus: toStringArray(value.judgeFocus),
  };
}

export function buildCreateAgentBenchmarkMetadata(input: {
  testCase: CreateAgentCase;
  judgeVersion?: string | null;
}): CreateAgentBenchmarkMetadata {
  return {
    workflow: "create-agent",
    benchmark: true,
    benchmarkCaseId: input.testCase.id,
    expectedPath: input.testCase.expectedPath,
    requestedRole: input.testCase.expectedAgentShape.role ?? null,
    requestedRuntimeType: input.testCase.expectedAgentShape.agentRuntimeType ?? null,
    evaluationVersion: CREATE_AGENT_EVALUATION_VERSION,
    judgeVersion: input.judgeVersion ?? null,
  };
}

export function buildCreateAgentBenchmarkTags(metadata: CreateAgentBenchmarkMetadata): string[] {
  return [
    "workflow:create-agent",
    "benchmark:true",
    `benchmark-case:${metadata.benchmarkCaseId}`,
  ];
}

export function encodeCreateAgentBenchmarkMetadataComment(metadata: CreateAgentBenchmarkMetadata): string {
  return `<!-- ${CREATE_AGENT_BENCHMARK_MARKER}:${JSON.stringify(metadata)} -->`;
}

export function appendCreateAgentBenchmarkMetadata(description: string, metadata: CreateAgentBenchmarkMetadata): string {
  const base = description.trim();
  return `${base}\n\n${encodeCreateAgentBenchmarkMetadataComment(metadata)}\n`;
}

export function extractCreateAgentBenchmarkMetadata(text: string | null | undefined): CreateAgentBenchmarkMetadata | null {
  if (!text) return null;
  const match = text.match(new RegExp(`<!--\\s*${CREATE_AGENT_BENCHMARK_MARKER}:(\\{[\\s\\S]*?\\})\\s*-->`, "i"));
  if (!match?.[1]) return null;
  try {
    return coerceCreateAgentBenchmarkMetadata(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

export function coerceCreateAgentBenchmarkMetadata(raw: unknown): CreateAgentBenchmarkMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = raw as Record<string, unknown>;
  if (
    parsed.workflow !== "create-agent"
    || parsed.benchmark !== true
    || nonEmptyString(parsed.benchmarkCaseId) == null
  ) {
    return null;
  }
  const expectedPath = nonEmptyString(parsed.expectedPath);
  if (expectedPath !== "direct_create" && expectedPath !== "approval_required" && expectedPath !== "reject_or_escalate") {
    return null;
  }
  return {
    workflow: "create-agent",
    benchmark: true,
    benchmarkCaseId: nonEmptyString(parsed.benchmarkCaseId)!,
    expectedPath,
    requestedRole: nonEmptyString(parsed.requestedRole),
    requestedRuntimeType: nonEmptyString(parsed.requestedRuntimeType),
    evaluationVersion: nonEmptyString(parsed.evaluationVersion) ?? CREATE_AGENT_EVALUATION_VERSION,
    judgeVersion: nonEmptyString(parsed.judgeVersion),
  };
}

function resolveExpectedReportsTo(testCase: CreateAgentCase, fixtureRefs: Record<string, string | undefined> = {}) {
  if (testCase.expectedAgentShape.reportsTo !== undefined) return testCase.expectedAgentShape.reportsTo;
  if (testCase.expectedAgentShape.reportsToFixture !== undefined) {
    return fixtureRefs[testCase.expectedAgentShape.reportsToFixture ?? ""] ?? null;
  }
  return undefined;
}

function evaluateFieldEquality(actual: string | null | undefined, expected: string | null | undefined) {
  if (expected === undefined) {
    return { value: "not_applicable" as const, comment: "No expected value defined for this case." };
  }
  if ((actual ?? null) === expected) {
    return { value: "pass" as const, comment: `Matched expected value ${expected ?? "null"}.` };
  }
  return {
    value: "fail" as const,
    comment: `Expected ${expected ?? "null"} but observed ${actual ?? "null"}.`,
  };
}

function findFilesystemFallbackMatches(detail: ObservedRunDetail): string[] {
  const haystacks = [
    detail.logContent ?? "",
    detail.run.stdoutExcerpt ?? "",
    detail.run.stderrExcerpt ?? "",
    ...detail.events.map((event) => event.message ?? ""),
    ...detail.transcript.map((entry) => previewTextForTranscriptEntry(entry, 400)),
  ];
  const matches = new Set<string>();
  for (const haystack of haystacks) {
    for (const { pattern, label } of FALLBACK_PATTERNS) {
      if (pattern.test(haystack)) {
        matches.add(label);
      }
    }
  }
  return [...matches];
}

function summarizeFinalOutput(detail: ObservedRunDetail): string {
  const trace = buildObservedRunTrace(detail);
  const lastModelStep = [...trace.steps].reverse().find((step) => step.isModelEntry && step.preview);
  if (lastModelStep?.preview) return lastModelStep.preview;
  const lastLoose = [...trace.steps].reverse().find((step) => step.preview);
  return lastLoose?.preview ?? detail.run.error ?? "No final output summary available";
}

function findPrimaryAgent(capturedAgents: CreateAgentCapturedAgent[], expectedPath: CreateAgentExpectedPath) {
  if (capturedAgents.length === 0) return null;
  if (expectedPath === "approval_required") {
    return capturedAgents.find((item) => item.agent.status === "pending_approval") ?? capturedAgents[0] ?? null;
  }
  return capturedAgents[0] ?? null;
}

function diffSkillKeys(snapshot: AgentSkillSnapshot | null): string[] {
  if (!snapshot) return [];
  return [...snapshot.desiredSkills].sort();
}

function evaluateDesiredSkills(actualSkills: string[], expectedSkills: string[] | undefined): CreateAgentEvalCheck {
  if (!expectedSkills || expectedSkills.length === 0) {
    return {
      value: "not_applicable",
      comment: "No expected desired skills defined for this case.",
    };
  }

  const actual = [...actualSkills].sort();
  const expected = [...expectedSkills].sort();
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    return {
      value: "pass",
      comment: `Matched desired skills (${expected.join(", ") || "none"}).`,
      metadata: { expectedSkills: expected, actualSkills: actual },
    };
  }
  return {
    value: "fail",
    comment: `Expected skills [${expected.join(", ")}] but observed [${actual.join(", ")}].`,
    metadata: { expectedSkills: expected, actualSkills: actual },
  };
}

function evaluateSourceIssueLink(
  input: EvaluateCreateAgentBenchmarkInput,
  primaryApproval: CreateAgentCapturedApproval | null,
): CreateAgentEvalCheck {
  if (!input.testCase.expectedAgentShape.sourceIssueRequired) {
    return {
      value: "not_applicable",
      comment: "Case does not require source issue linkage.",
    };
  }
  if (!input.issueId) {
    return {
      value: "uncertain",
      comment: "Run detail does not expose a linked issue id.",
    };
  }
  if (!primaryApproval) {
    return {
      value: "uncertain",
      comment: "No approval surface exists for direct-create linkage verification.",
    };
  }
  if (primaryApproval.issueIds.includes(input.issueId)) {
    return {
      value: "pass",
      comment: `Approval ${primaryApproval.approval.id} links benchmark issue ${input.issueId}.`,
    };
  }
  return {
    value: "fail",
    comment: `Approval ${primaryApproval.approval.id} does not link benchmark issue ${input.issueId}.`,
    metadata: { issueIds: primaryApproval.issueIds, expectedIssueId: input.issueId },
  };
}

function aggregateOverallCheck(checks: Array<CreateAgentEvalCheck>): CreateAgentEvalCheck {
  if (checks.some((check) => check.value === "fail")) {
    return {
      value: "fail",
      comment: "At least one deterministic correctness check failed.",
    };
  }
  if (checks.some((check) => check.value === "uncertain")) {
    return {
      value: "uncertain",
      comment: "No deterministic failures were found, but at least one required check is uncertain.",
    };
  }
  return {
    value: "pass",
    comment: "All deterministic create-agent correctness checks passed.",
  };
}

export function evaluateCreateAgentBenchmark(
  input: EvaluateCreateAgentBenchmarkInput & { fixtureRefs?: Record<string, string | undefined> },
): CreateAgentEvalResult {
  const primaryAgent = findPrimaryAgent(input.createdAgents, input.testCase.expectedPath);
  const primaryApproval = input.createdApprovals[0] ?? null;
  const expectedReportsTo = resolveExpectedReportsTo(input.testCase, input.fixtureRefs);
  const filesystemFallbackMatches = findFilesystemFallbackMatches(input.runDetail);
  const finalOutputSummary = summarizeFinalOutput(input.runDetail);
  const runSucceeded = input.runDetail.run.status === "succeeded";
  const runTerminal = TERMINAL_RUN_STATUSES.has(input.runDetail.run.status);
  const sideEffectObserved = input.createdAgents.length > 0 || input.createdApprovals.length > 0;

  const requestCompleted: CreateAgentEvalCheck = input.testCase.expectedPath === "reject_or_escalate"
    ? {
      value: runSucceeded && input.createdAgents.length === 0 && input.createdApprovals.length === 0 ? "pass" : "fail",
      comment: runSucceeded && input.createdAgents.length === 0 && input.createdApprovals.length === 0
        ? "Run completed without creating agent or approval, matching the reject/escalate path."
        : "Reject/escalate case still created agent/approval or failed the run.",
    }
    : {
      value: sideEffectObserved ? "pass" : "fail",
      comment: sideEffectObserved
        ? runTerminal
          ? "Run reached a create-agent side effect."
          : `Run produced a create-agent side effect before reaching terminal status (${input.runDetail.run.status}).`
        : "Run did not reach a create-agent side effect.",
    };

  let pathCorrect: CreateAgentEvalCheck;
  switch (input.testCase.expectedPath) {
    case "approval_required":
      pathCorrect = input.createdApprovals.length > 0 && primaryAgent?.agent.status === "pending_approval"
        ? {
          value: "pass",
          comment: "Observed approval-required path with a pending approval agent.",
        }
        : {
          value: "fail",
          comment: "Expected approval-required path but did not observe a pending-approval agent plus approval.",
        };
      break;
    case "direct_create":
      pathCorrect = input.createdApprovals.length === 0 && primaryAgent != null && primaryAgent.agent.status !== "pending_approval"
        ? {
          value: "pass",
          comment: "Observed direct create path without approval.",
        }
        : {
          value: "fail",
          comment: "Expected direct create path but observed approval or missing created agent.",
        };
      break;
    case "reject_or_escalate":
      pathCorrect = input.createdApprovals.length === 0 && input.createdAgents.length === 0
        ? {
          value: "pass",
          comment: "Observed no created agent or approval for reject/escalate path.",
        }
        : {
          value: "fail",
          comment: "Reject/escalate path still created an agent or approval.",
        };
      break;
  }

  const payloadValid: CreateAgentEvalCheck = primaryAgent
    ? {
      value:
        (!input.testCase.expectedAgentShape.name || primaryAgent.agent.name === input.testCase.expectedAgentShape.name)
          && (!input.testCase.expectedAgentShape.role || primaryAgent.agent.role === input.testCase.expectedAgentShape.role)
          && (input.testCase.expectedAgentShape.title === undefined || (primaryAgent.agent.title ?? null) === input.testCase.expectedAgentShape.title)
          ? "pass"
          : "fail",
      comment:
        (!input.testCase.expectedAgentShape.name || primaryAgent.agent.name === input.testCase.expectedAgentShape.name)
          && (!input.testCase.expectedAgentShape.role || primaryAgent.agent.role === input.testCase.expectedAgentShape.role)
          && (input.testCase.expectedAgentShape.title === undefined || (primaryAgent.agent.title ?? null) === input.testCase.expectedAgentShape.title)
          ? "Created agent payload matched expected identity fields."
          : "Created agent payload does not match expected name/role/title fields.",
    }
    : input.testCase.expectedPath === "reject_or_escalate"
      ? {
        value: "not_applicable",
        comment: "Reject/escalate cases do not create an agent payload.",
      }
      : {
        value: "fail",
        comment: "Expected a created agent payload but none was observed.",
      };

  const reportsToCheck: CreateAgentEvalCheck = primaryAgent
    ? evaluateFieldEquality(primaryAgent.agent.reportsTo, expectedReportsTo)
    : {
      value: input.testCase.expectedPath === "reject_or_escalate" ? "not_applicable" : "fail",
      comment: input.testCase.expectedPath === "reject_or_escalate"
        ? "Reject/escalate cases do not create an agent."
        : "No created agent available for reportsTo validation.",
    };

  const runtimeCheck: CreateAgentEvalCheck = primaryAgent
    ? evaluateFieldEquality(primaryAgent.agent.agentRuntimeType, input.testCase.expectedAgentShape.agentRuntimeType)
    : {
      value: input.testCase.expectedPath === "reject_or_escalate" ? "not_applicable" : "fail",
      comment: input.testCase.expectedPath === "reject_or_escalate"
        ? "Reject/escalate cases do not create an agent."
        : "No created agent available for runtime validation.",
    };

  const skillsCheck: CreateAgentEvalCheck = primaryAgent
    ? evaluateDesiredSkills(diffSkillKeys(primaryAgent.skills), input.testCase.expectedAgentShape.desiredSkills)
    : {
      value: input.testCase.expectedPath === "reject_or_escalate" ? "not_applicable" : "fail",
      comment: input.testCase.expectedPath === "reject_or_escalate"
        ? "Reject/escalate cases do not create an agent."
        : "No created agent available for skill validation.",
    };

  const sourceIssueLinkCheck = evaluateSourceIssueLink(input, primaryApproval);
  const noFilesystemFallback: CreateAgentEvalCheck = filesystemFallbackMatches.length === 0
    ? {
      value: "pass",
      comment: "No filesystem fallback signal was detected in transcript or logs.",
    }
    : {
      value: "fail",
      comment: `Detected filesystem fallback signals: ${filesystemFallbackMatches.join(", ")}`,
      metadata: { matches: filesystemFallbackMatches },
    };

  const overallCorrectness = aggregateOverallCheck([
    requestCompleted,
    pathCorrect,
    payloadValid,
    reportsToCheck,
    runtimeCheck,
    skillsCheck,
    sourceIssueLinkCheck,
    noFilesystemFallback,
  ]);

  const reviewReasons: string[] = [];
  if (overallCorrectness.value !== "pass") {
    reviewReasons.push(`deterministic:${overallCorrectness.value}`);
  }
  if (!runTerminal) {
    reviewReasons.push(`run_incomplete:${input.runDetail.run.status}`);
  }
  if (input.judge?.status === "completed") {
    if ((input.judge.configQuality ?? 0) < 4) reviewReasons.push("judge:config_quality_low");
    if ((input.judge.reasoningQuality ?? 0) < 4) reviewReasons.push("judge:reasoning_quality_low");
    if ((input.judge.governanceJudgmentQuality ?? 0) < 4) reviewReasons.push("judge:governance_quality_low");
  } else if (input.judge?.status === "failed") {
    reviewReasons.push("judge:failed");
  }

  const finalClassification: CreateAgentFinalClassification =
    overallCorrectness.value === "fail"
      ? "fail"
      : reviewReasons.length > 0 || overallCorrectness.value === "uncertain"
        ? "needs_review"
        : "pass";

  return {
    evaluationVersion: CREATE_AGENT_EVALUATION_VERSION,
    benchmarkMetadata: input.benchmarkMetadata,
    issueId: input.issueId,
    runId: input.runDetail.run.id,
    runStatus: input.runDetail.run.status,
    checks: {
      create_agent_request_completed: requestCompleted,
      create_agent_path_correct: pathCorrect,
      create_agent_payload_valid: payloadValid,
      create_agent_reports_to_valid: reportsToCheck,
      create_agent_runtime_valid: runtimeCheck,
      create_agent_skills_valid: skillsCheck,
      create_agent_source_issue_linked: sourceIssueLinkCheck,
      create_agent_no_filesystem_fallback: noFilesystemFallback,
      create_agent_overall_correctness: overallCorrectness,
    },
    judge: input.judge,
    finalClassification,
    reviewerStatus: reviewReasons.length > 0 ? "pending" : "not_required",
    shouldQueueForReview: reviewReasons.length > 0,
    reviewReasons,
    finalOutputSummary,
    filesystemFallbackMatches,
    createdAgents: input.createdAgents,
    createdApprovals: input.createdApprovals,
  };
}

export function createAgentEvalCheckToScoreValue(check: CreateAgentEvalCheck): boolean | string {
  switch (check.value) {
    case "pass":
      return true;
    case "fail":
      return false;
    case "uncertain":
      return "uncertain";
    case "not_applicable":
      return "not_applicable";
  }
}

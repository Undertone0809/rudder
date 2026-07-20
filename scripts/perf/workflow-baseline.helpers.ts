import { createHash } from "node:crypto";

export type ScaleName = "smoke" | "medium" | "cost-heavy" | "thread-heavy";

export const WORKLOAD_MANIFEST_VERSION = 2;
export const THREAD_PRESSURE_RECIPE = {
  timestampTieWidth: 4,
  payloadVariantCount: 4,
  chatTurnWidth: 2,
  transcriptEvery: 31,
  transcriptEntries: 24,
  alternateVariantRows: 2,
  activityOnlyRunEvery: 4,
  activeRunStatuses: ["queued", "running"] as const,
  terminalRunStatuses: ["succeeded", "failed", "cancelled", "timed_out"] as const,
};

export type ScenarioScale = {
  agents: number;
  issues: number;
  issueCommentsPerIssue: number;
  chats: number;
  chatMessagesPerChat: number;
  approvals: number;
  approvalCommentsPerApproval: number;
  failedRuns: number;
  joinRequests: number;
  costEvents: number;
  hotChatMessages: number;
  hotIssueComments: number;
  hotIssueRuns: number;
  neighborOrgSentinels: number;
};

const SCALES: Record<ScaleName, ScenarioScale> = {
  smoke: {
    agents: 12,
    issues: 120,
    issueCommentsPerIssue: 2,
    chats: 40,
    chatMessagesPerChat: 2,
    approvals: 40,
    approvalCommentsPerApproval: 1,
    failedRuns: 30,
    joinRequests: 10,
    costEvents: 80,
    hotChatMessages: 0,
    hotIssueComments: 0,
    hotIssueRuns: 0,
    neighborOrgSentinels: 0,
  },
  medium: {
    agents: 40,
    issues: 1_500,
    issueCommentsPerIssue: 3,
    chats: 400,
    chatMessagesPerChat: 3,
    approvals: 300,
    approvalCommentsPerApproval: 2,
    failedRuns: 500,
    joinRequests: 100,
    costEvents: 1_500,
    hotChatMessages: 0,
    hotIssueComments: 0,
    hotIssueRuns: 0,
    neighborOrgSentinels: 0,
  },
  "cost-heavy": {
    agents: 40,
    issues: 200,
    issueCommentsPerIssue: 2,
    chats: 100,
    chatMessagesPerChat: 2,
    approvals: 80,
    approvalCommentsPerApproval: 1,
    failedRuns: 100,
    joinRequests: 20,
    costEvents: 50_000,
    hotChatMessages: 0,
    hotIssueComments: 0,
    hotIssueRuns: 0,
    neighborOrgSentinels: 0,
  },
  "thread-heavy": {
    agents: 16,
    issues: 40,
    issueCommentsPerIssue: 2,
    chats: 20,
    chatMessagesPerChat: 2,
    approvals: 20,
    approvalCommentsPerApproval: 1,
    failedRuns: 20,
    joinRequests: 5,
    costEvents: 100,
    hotChatMessages: 5_000,
    hotIssueComments: 2_000,
    hotIssueRuns: 1_000,
    neighborOrgSentinels: 3,
  },
};

export function isScaleName(value: string): value is ScaleName {
  return value in SCALES;
}

export function scaleNames(): ScaleName[] {
  return Object.keys(SCALES) as ScaleName[];
}

export function getScenarioScale(name: ScaleName): ScenarioScale {
  return SCALES[name];
}

export function workloadManifestHash(
  name: ScaleName,
  threadPressureRecipe = THREAD_PRESSURE_RECIPE,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: WORKLOAD_MANIFEST_VERSION,
      name,
      scale: getScenarioScale(name),
      threadPressureRecipe: name === "thread-heavy" ? threadPressureRecipe : null,
    }))
    .digest("hex")
    .slice(0, 16);
}

export type TimingSample = { name: string; ms: number };

function nearestRank(values: number[], percentile: number): number {
  const rank = Math.max(1, Math.ceil(percentile * values.length));
  return values[rank - 1]!;
}

export function summarizeTimingSamples(samples: TimingSample[]) {
  const byName = new Map<string, number[]>();
  for (const sample of samples) {
    const existing = byName.get(sample.name) ?? [];
    existing.push(sample.ms);
    byName.set(sample.name, existing);
  }
  return Array.from(byName.entries()).map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((acc, value) => acc + value, 0);
    return {
      name,
      runs: values.length,
      minMs: sorted[0],
      p50Ms: nearestRank(sorted, 0.5),
      p95Ms: nearestRank(sorted, 0.95),
      maxMs: sorted[sorted.length - 1],
      avgMs: Number((sum / values.length).toFixed(2)),
    };
  });
}

type SequenceGateRow = {
  id: string;
  orgId: string;
  parentId: string | null;
  createdAt: string | Date;
};

export type SequenceGateInput = {
  name: string;
  expectedCount: number;
  expectedIds?: string[];
  expectedOrgId: string;
  expectedParentId: string;
  rows: SequenceGateRow[];
  order: "asc" | "desc";
};

export function evaluateSequenceGates(input: SequenceGateInput) {
  const violations: string[] = [];
  if (input.rows.length !== input.expectedCount) {
    violations.push(`${input.name}:count=${input.rows.length},expected=${input.expectedCount}`);
  }

  const uniqueIds = new Set(input.rows.map((row) => row.id));
  const duplicateCount = input.rows.length - uniqueIds.size;
  if (duplicateCount > 0) {
    violations.push(`${input.name}:duplicate_ids=${duplicateCount}`);
  }

  if (input.expectedIds) {
    const expectedIds = new Set(input.expectedIds);
    const missingIds = input.expectedIds.filter((id) => !uniqueIds.has(id)).length;
    const unexpectedIds = [...uniqueIds].filter((id) => !expectedIds.has(id)).length;
    if (missingIds > 0) {
      violations.push(`${input.name}:missing_ids=${missingIds}`);
    }
    if (unexpectedIds > 0) {
      violations.push(`${input.name}:unexpected_ids=${unexpectedIds}`);
    }
  }

  let outOfOrder = 0;
  for (let index = 1; index < input.rows.length; index += 1) {
    const previous = input.rows[index - 1]!;
    const current = input.rows[index]!;
    const previousTime = new Date(previous.createdAt).getTime();
    const currentTime = new Date(current.createdAt).getTime();
    const comparison = previousTime === currentTime
      ? previous.id.localeCompare(current.id)
      : previousTime - currentTime;
    if ((input.order === "asc" && comparison > 0) || (input.order === "desc" && comparison < 0)) {
      outOfOrder += 1;
    }
  }
  if (outOfOrder > 0) {
    violations.push(`${input.name}:out_of_order=${outOfOrder}`);
  }

  const wrongParent = input.rows.filter((row) => row.parentId !== input.expectedParentId).length;
  if (wrongParent > 0) {
    violations.push(`${input.name}:wrong_parent=${wrongParent}`);
  }

  const crossOrg = input.rows.filter((row) => row.orgId !== input.expectedOrgId).length;
  if (crossOrg > 0) {
    violations.push(`${input.name}:cross_org=${crossOrg}`);
  }

  return {
    name: input.name,
    passed: violations.length === 0,
    count: input.rows.length,
    violations,
  };
}

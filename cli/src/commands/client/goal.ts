import {
  createGoalActivitySchema,
  createGoalChangeProposalSchema,
  createGoalResultProposalSchema,
} from "@rudderhq/shared";
import { Command } from "commander";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface GoalProgressOptions extends BaseClientOptions {
  summary: string;
  activityKind?: string;
  evidenceRefs: string;
  idempotencyKey: string;
}

interface GoalListOptions extends BaseClientOptions {
  lifecycle: string;
  focus?: string;
  facet?: string;
  limit: string;
}

interface GoalResultOptions extends BaseClientOptions {
  contractRevision: string;
  criteria: string;
  evidenceRefs: string;
  resultValue?: string;
  decision?: string;
  resultPayload?: string;
  riskSummary: string;
  idempotencyKey: string;
}

interface GoalChangeOptions extends BaseClientOptions {
  contractRevision: string;
  afterContract: string;
  rationale: string;
  evidenceRefs?: string;
  idempotencyKey: string;
}

export function registerGoalCommands(program: Command): void {
  const goal = program.command("goal").description("Goal Owner runtime operations");

  addCommonClientOptions(
    goal
      .command("list")
      .description(getAgentCliCapabilityById("goal.list").description)
      .option("--lifecycle <state>", "draft, active, closed, or all", "active")
      .option("--focus <true|false>", "Filter by organization Focus state")
      .option("--facet <facet>", "Filter by current workspace attention facet")
      .option("--limit <n>", "Maximum Goals to return (1-100)", "20")
      .action(async (opts: GoalListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (!ctx.agentId) throw new Error("Agent ID is required. Set RUDDER_AGENT_ID.");
          const params = new URLSearchParams({
            lifecycle: opts.lifecycle,
            limit: opts.limit,
          });
          if (opts.focus !== undefined) params.set("focus", opts.focus);
          if (opts.facet) params.set("facet", opts.facet);
          const response = await ctx.api.get(`/api/orgs/${ctx.orgId}/goals/assigned?${params}`);
          printOutput(response, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    goal
      .command("context")
      .description(getAgentCliCapabilityById("goal.context").description)
      .argument("<goalId>", "Goal ID returned by goal list")
      .action(async (goalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          if (!ctx.agentId) throw new Error("Agent ID is required. Set RUDDER_AGENT_ID.");
          const response = await ctx.api.get(`/api/goals/${goalId}/agent-context`);
          printOutput(response, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    goal
      .command("progress")
      .description(getAgentCliCapabilityById("goal.progress").description)
      .argument("<goalId>", "Goal ID from the current Goal Runtime Context")
      .requiredOption("--summary <text>", "Plain-language progress summary")
      .option("--activity-kind <kind>", "progress, evidence, or bottleneck", "progress")
      .requiredOption("--evidence-refs <json>", "JSON array of URI-like evidence references")
      .requiredOption("--idempotency-key <key>", "Stable key for safe retry")
      .action(async (goalId: string, opts: GoalProgressOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createGoalActivitySchema.parse({
            summary: opts.summary,
            activityKind: opts.activityKind,
            evidenceRefs: parseJsonArray(opts.evidenceRefs, "evidence refs"),
            idempotencyKey: opts.idempotencyKey,
          });
          const activity = await ctx.api.post(`/api/goals/${goalId}/activities`, payload);
          printOutput(activity, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const change = goal.command("change").description("Goal contract change operations");
  addCommonClientOptions(
    change
      .command("propose")
      .description(getAgentCliCapabilityById("goal.change.propose").description)
      .argument("<goalId>", "Goal ID from the current Goal Runtime Context")
      .requiredOption("--contract-revision <n>", "Current Goal contract revision")
      .requiredOption("--after-contract <json>", "JSON object containing only proposed contract field changes")
      .requiredOption("--rationale <text>", "Why the current Goal contract should change")
      .option("--evidence-refs <json>", "JSON array of URI-like evidence references", "[]")
      .requiredOption("--idempotency-key <key>", "Stable key for safe retry")
      .action(async (goalId: string, opts: GoalChangeOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createGoalChangeProposalSchema.parse({
            expectedContractRevision: Number(opts.contractRevision),
            afterContract: parseJsonObject(opts.afterContract, "after contract"),
            rationale: opts.rationale,
            evidenceRefs: parseJsonArray(opts.evidenceRefs ?? "[]", "evidence refs"),
            idempotencyKey: opts.idempotencyKey,
          });
          const proposal = await ctx.api.post(`/api/goals/${goalId}/change-proposals`, payload);
          printOutput(proposal, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const result = goal.command("result").description("Goal result operations");
  addCommonClientOptions(
    result
      .command("propose")
      .description(getAgentCliCapabilityById("goal.result.propose").description)
      .argument("<goalId>", "Goal ID from the current Goal Runtime Context")
      .requiredOption("--contract-revision <n>", "Current Goal contract revision")
      .requiredOption("--criteria <json>", "JSON array of criterion id/status objects")
      .requiredOption("--evidence-refs <json>", "JSON array of URI-like evidence references")
      .option("--result-value <json-or-text>", "Optional measured result value")
      .option("--decision <text>", "Optional decision for decide-mode Goals")
      .option("--result-payload <json>", "Optional structured result details")
      .requiredOption("--risk-summary <text>", "Known risks, limitations, or remaining gaps")
      .requiredOption("--idempotency-key <key>", "Stable key for safe retry")
      .action(async (goalId: string, opts: GoalResultOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createGoalResultProposalSchema.parse({
            contractRevision: Number(opts.contractRevision),
            criteria: parseJsonArray(opts.criteria, "criteria"),
            evidenceRefs: parseJsonArray(opts.evidenceRefs, "evidence refs"),
            ...(opts.resultValue !== undefined ? { resultValue: parseResultValue(opts.resultValue) } : {}),
            ...(opts.decision !== undefined ? { decision: opts.decision } : {}),
            ...(opts.resultPayload !== undefined
              ? { resultPayload: parseJsonObject(opts.resultPayload, "result payload") }
              : {}),
            riskSummary: opts.riskSummary,
            idempotencyKey: opts.idempotencyKey,
          });
          const proposal = await ctx.api.post(`/api/goals/${goalId}/result-proposals`, payload);
          printOutput(proposal, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJsonArray(value: string, label: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseResultValue(value: string): string | number | boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
      return parsed;
    }
  } catch {
    return value;
  }
  throw new Error("result value must be a string, number, or boolean");
}

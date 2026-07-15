import type { ObservedRunDetail } from "@rudderhq/run-intelligence-core";
import {
  appendCreateAgentBenchmarkMetadata,
  buildCreateAgentBenchmarkMetadata,
  CREATE_AGENT_LOCAL_JUDGE_VERSION,
  evaluateCreateAgentBenchmark,
  parseCreateAgentCase,
  type CreateAgentBenchmarkMetadata,
  type CreateAgentCapturedAgent,
  type CreateAgentCapturedApproval,
  type CreateAgentCase,
  type CreateAgentEvalCheck,
  type CreateAgentEvalResult,
  type CreateAgentJudgeResult
} from "@rudderhq/run-intelligence-core";
import type {
  Agent,
  AgentSkillSnapshot,
  Approval,
  Issue,
} from "@rudderhq/shared";
import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseClientOptions } from "./client/common.js";
import {
  addCommonClientOptions,
  formatCliRunId,
  handleCommandError,
  printOutput,
  resolveCommandContext,
} from "./client/common.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__moduleDir, "../../..");
const defaultCasesDir = path.join(repoRoot, "benchmark", "create-agent", "cases");
const defaultSetsDir = path.join(repoRoot, "benchmark", "create-agent", "sets");
const defaultArtifactsDir = path.join(repoRoot, ".artifacts", "create-agent-benchmark");
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const DEFAULT_JUDGE_MODEL = "gpt-5-mini";

interface BenchmarkCreateAgentBaseOptions extends BaseClientOptions {
  orgId?: string;
  benchmarkAgentId?: string;
  casesDir?: string;
  setsDir?: string;
  artifactsDir?: string;
  fixture?: string[];
  waitTimeoutSec?: string;
  pollIntervalMs?: string;
  judge?: boolean;
  judgeModel?: string;
}

interface BenchmarkRunOptions extends BenchmarkCreateAgentBaseOptions {}
interface BenchmarkRunSetOptions extends BenchmarkCreateAgentBaseOptions {
  continueOnError?: boolean;
}
interface BenchmarkRescoreOptions extends BenchmarkCreateAgentBaseOptions {}
interface BenchmarkReportOptions extends BaseClientOptions {
  markdown?: boolean;
}

interface StoredCreateAgentBenchmarkResult {
  version: "create-agent-benchmark-run-v1";
  generatedAt: string;
  runner?: {
    waitTimedOut: boolean;
    timeoutMs: number;
  };
  case: CreateAgentCase;
  fixtureRefs: Record<string, string>;
  benchmarkMetadata: CreateAgentBenchmarkMetadata;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
  };
  runDetail: ObservedRunDetail;
  createdAgents: CreateAgentCapturedAgent[];
  createdApprovals: CreateAgentCapturedApproval[];
  evaluation: CreateAgentEvalResult;
}

type JsonRecord = Record<string, unknown>;
type CreateAgentCheckEntries = Array<[keyof CreateAgentEvalResult["checks"], CreateAgentEvalCheck]>;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getCheckEntries(checks: CreateAgentEvalResult["checks"]): CreateAgentCheckEntries {
  return Object.entries(checks) as CreateAgentCheckEntries;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFixtureRefs(values: string[] | undefined): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const raw of values ?? []) {
    const [key, ...rest] = raw.split("=");
    const value = rest.join("=");
    if (!key || !value) {
      throw new Error(`Invalid --fixture value "${raw}". Expected key=value.`);
    }
    refs[key.trim()] = value.trim();
  }
  return refs;
}

function ensureRequiredFixtures(testCase: CreateAgentCase, fixtureRefs: Record<string, string>) {
  for (const key of testCase.fixtures?.requiredFixtureKeys ?? []) {
    if (!fixtureRefs[key]) {
      throw new Error(`Case ${testCase.id} requires fixture "${key}". Pass --fixture ${key}=<id>.`);
    }
  }
}

function createBenchmarkIssueTitle(testCase: CreateAgentCase): string {
  return `[benchmark:create-agent] ${testCase.id}`;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content) as T;
}

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadCaseById(caseId: string, casesDir: string): Promise<CreateAgentCase> {
  const filePath = path.join(casesDir, `${caseId}.json`);
  return parseCreateAgentCase(await readJsonFile(filePath));
}

async function loadSet(setName: string, setsDir: string): Promise<string[]> {
  const filePath = path.join(setsDir, `${setName}.json`);
  const raw = await readJsonFile<unknown>(filePath);
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error(`Benchmark set ${setName} must be a JSON array of case IDs.`);
  }
  return raw as string[];
}

async function listAgents(apiBase: ReturnType<typeof resolveCommandContext>["api"], orgId: string): Promise<Agent[]> {
  return (await apiBase.get<Agent[]>(`/api/orgs/${orgId}/agents`)) ?? [];
}

async function listApprovals(apiBase: ReturnType<typeof resolveCommandContext>["api"], orgId: string): Promise<Approval[]> {
  return (await apiBase.get<Approval[]>(`/api/orgs/${orgId}/approvals`)) ?? [];
}

async function createIssue(
  api: ReturnType<typeof resolveCommandContext>["api"],
  orgId: string,
  payload: Partial<Issue> & { title: string; description: string; assigneeAgentId: string },
): Promise<Issue> {
  const issue = await api.post<Issue>(`/api/orgs/${orgId}/issues`, {
    title: payload.title,
    description: payload.description,
    assigneeAgentId: payload.assigneeAgentId,
    status: "todo",
    priority: "medium",
  });
  if (!issue) throw new Error("Issue creation returned an empty response.");
  return issue;
}

async function getIssue(api: ReturnType<typeof resolveCommandContext>["api"], issueId: string): Promise<Issue> {
  const issue = await api.get<Issue>(`/api/issues/${issueId}`);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);
  return issue;
}

async function waitForIssueExecutionRun(
  api: ReturnType<typeof resolveCommandContext>["api"],
  issueId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<Issue> {
  const deadline = Date.now() + timeoutMs;
  let latestIssue = await getIssue(api, issueId);
  while (Date.now() < deadline) {
    if (latestIssue.executionRunId) return latestIssue;
    await sleep(pollIntervalMs);
    latestIssue = await getIssue(api, issueId);
  }
  throw new Error(`Timed out waiting for issue ${issueId} to receive an executionRunId.`);
}

export async function waitForRunCompletion(
  api: ReturnType<typeof resolveCommandContext>["api"],
  runId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<{ detail: ObservedRunDetail; waitTimedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let detail = await getObservedRunDetail(api, runId);
  while (Date.now() < deadline) {
    if (TERMINAL_RUN_STATUSES.has(detail.run.status)) {
      return { detail, waitTimedOut: false };
    }
    await sleep(pollIntervalMs);
    detail = await getObservedRunDetail(api, runId);
  }
  return { detail, waitTimedOut: true };
}

async function getObservedRunDetail(
  api: ReturnType<typeof resolveCommandContext>["api"],
  runId: string,
): Promise<ObservedRunDetail> {
  const detail = await api.get<ObservedRunDetail>(
    `/api/run-intelligence/runs/${encodeURIComponent(runId)}?projection=full`,
  );
  if (!detail) throw new Error(`Observed run not found: ${runId}`);
  return detail;
}

async function getAgentSkills(
  api: ReturnType<typeof resolveCommandContext>["api"],
  agentId: string,
): Promise<AgentSkillSnapshot | null> {
  return await api.get<AgentSkillSnapshot>(`/api/agents/${agentId}/skills`, { ignoreNotFound: true });
}

async function getApprovalIssueIds(
  api: ReturnType<typeof resolveCommandContext>["api"],
  approvalId: string,
): Promise<string[]> {
  const issues = await api.get<Array<{ id: string }>>(`/api/approvals/${approvalId}/issues`);
  return (issues ?? []).map((issue) => issue.id);
}

function diffCreatedAgents(before: Agent[], after: Agent[]): Agent[] {
  const beforeIds = new Set(before.map((agent) => agent.id));
  return after.filter((agent) => !beforeIds.has(agent.id));
}

function diffCreatedApprovals(before: Approval[], after: Approval[]): Approval[] {
  const beforeIds = new Set(before.map((approval) => approval.id));
  return after.filter((approval) => !beforeIds.has(approval.id));
}

async function captureCreatedAgents(
  api: ReturnType<typeof resolveCommandContext>["api"],
  agents: Agent[],
): Promise<CreateAgentCapturedAgent[]> {
  return Promise.all(
    agents.map(async (agent) => ({
      agent,
      skills: await getAgentSkills(api, agent.id),
    })),
  );
}

async function captureCreatedApprovals(
  api: ReturnType<typeof resolveCommandContext>["api"],
  approvals: Approval[],
): Promise<CreateAgentCapturedApproval[]> {
  return Promise.all(
    approvals.map(async (approval) => ({
      approval,
      issueIds: await getApprovalIssueIds(api, approval.id),
    })),
  );
}

function resultRunDir(artifactsDir: string, testCase: CreateAgentCase, runId: string) {
  return path.join(artifactsDir, "runs", `${testCase.id}-${runId}`);
}

function resultJsonPath(artifactsDir: string, testCase: CreateAgentCase, runId: string) {
  return path.join(resultRunDir(artifactsDir, testCase, runId), "result.json");
}

function reportMarkdownPath(artifactsDir: string, testCase: CreateAgentCase, runId: string) {
  return path.join(resultRunDir(artifactsDir, testCase, runId), "report.md");
}

function averageJudgeScore(judge: CreateAgentJudgeResult | null): number | null {
  if (!judge || judge.status !== "completed") return null;
  const values = [judge.configQuality, judge.reasoningQuality, judge.governanceJudgmentQuality]
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildMarkdownReport(result: StoredCreateAgentBenchmarkResult): string {
  const lines = [
    `# Create-Agent Benchmark Report`,
    ``,
    `- Case: \`${result.case.id}\``,
    `- Run: \`${formatCliRunId(result.runDetail.run.id)}\``,
    `- Run status: \`${result.runDetail.run.status}\``,
    `- Issue: ${result.issue.identifier ?? result.issue.id}`,
    `- Classification: \`${result.evaluation.finalClassification}\``,
    `- Reviewer status: \`${result.evaluation.reviewerStatus}\``,
    `- Runner timeout: \`${result.runner?.waitTimedOut === true ? "timed_out" : "completed"}\``,
    ``,
    `## Deterministic Checks`,
  ];

  for (const [name, check] of getCheckEntries(result.evaluation.checks)) {
    lines.push(`- \`${name}\`: \`${check.value}\` — ${check.comment}`);
  }

  lines.push(
    ``,
    `## Judge`,
    `- Status: \`${result.evaluation.judge?.status ?? "skipped"}\``,
    `- Version: \`${result.evaluation.judge?.version ?? "none"}\``,
    `- Summary: ${result.evaluation.judge?.summary ?? "(none)"}`,
    ``,
    `## Outcome`,
    `- Final output summary: ${result.evaluation.finalOutputSummary}`,
    `- Created agents: ${result.createdAgents.map((item) => item.agent.name).join(", ") || "(none)"}`,
    `- Created approvals: ${result.createdApprovals.map((item) => item.approval.id).join(", ") || "(none)"}`,
    `- Review reasons: ${result.evaluation.reviewReasons.join(", ") || "(none)"}`,
  );

  return `${lines.join("\n")}\n`;
}

function promptContextForJudge(result: StoredCreateAgentBenchmarkResult): string {
  const createdAgent = result.createdAgents[0]?.agent ?? null;
  const createdApproval = result.createdApprovals[0]?.approval ?? null;
  const payload = {
    case: {
      id: result.case.id,
      prompt: result.case.prompt,
      expectedPath: result.case.expectedPath,
      expectedAgentShape: result.case.expectedAgentShape,
      judgeFocus: result.case.judgeFocus ?? [],
    },
    deterministicChecks: result.evaluation.checks,
    observed: {
      finalOutputSummary: result.evaluation.finalOutputSummary,
      createdAgent,
      createdApproval,
      reviewReasons: result.evaluation.reviewReasons,
    },
  };
  return JSON.stringify(payload, null, 2);
}

function buildLocalJudgePrompt(): string {
  return [
    "You are evaluating the quality of a create-agent run.",
    "Return JSON with keys configQuality, reasoningQuality, governanceJudgmentQuality, summary.",
    "Scores must be integers 1-5.",
    "Judge only quality and reasoning. Do not override deterministic correctness.",
  ].join("\n");
}

async function runCreateAgentJudge(result: StoredCreateAgentBenchmarkResult, modelOverride?: string): Promise<CreateAgentJudgeResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      status: "skipped",
      version: CREATE_AGENT_LOCAL_JUDGE_VERSION,
      summary: "OPENAI_API_KEY is not configured; judge was skipped.",
      configQuality: null,
      reasoningQuality: null,
      governanceJudgmentQuality: null,
      error: null,
    };
  }

  const prompt = buildLocalJudgePrompt();
  const version = CREATE_AGENT_LOCAL_JUDGE_VERSION;
  const model = modelOverride?.trim() || process.env.CREATE_AGENT_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: prompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: `Return JSON.\n\n${promptContextForJudge(result)}` }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "create_agent_judge",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["configQuality", "reasoningQuality", "governanceJudgmentQuality", "summary"],
            properties: {
              configQuality: { type: "integer", minimum: 1, maximum: 5 },
              reasoningQuality: { type: "integer", minimum: 1, maximum: 5 },
              governanceJudgmentQuality: { type: "integer", minimum: 1, maximum: 5 },
              summary: { type: "string", minLength: 1 },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return {
      status: "failed",
      version,
      summary: null,
      configQuality: null,
      reasoningQuality: null,
      governanceJudgmentQuality: null,
      error: body,
    };
  }

  const body = await response.json() as JsonRecord;
  const outputText = asString(body.output_text) ?? extractOpenAiOutputText(body.output);
  if (!outputText) {
    return {
      status: "failed",
      version,
      summary: null,
      configQuality: null,
      reasoningQuality: null,
      governanceJudgmentQuality: null,
      error: "Judge response did not contain output_text.",
    };
  }

  const parsed = JSON.parse(outputText) as JsonRecord;
  return {
    status: "completed",
    version,
    summary: asString(parsed.summary),
    configQuality: Number(parsed.configQuality),
    reasoningQuality: Number(parsed.reasoningQuality),
    governanceJudgmentQuality: Number(parsed.governanceJudgmentQuality),
  };
}

function extractOpenAiOutputText(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const content = (item as JsonRecord).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const value = asString((part as JsonRecord).text);
      if (value) return value;
    }
  }
  return null;
}

async function executeBenchmarkCase(caseId: string, opts: BenchmarkRunOptions): Promise<StoredCreateAgentBenchmarkResult> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const benchmarkAgentId = asString(opts.benchmarkAgentId);
  if (!benchmarkAgentId) {
    throw new Error("Pass --benchmark-agent-id to run a create-agent benchmark case.");
  }

  const casesDir = opts.casesDir?.trim() || defaultCasesDir;
  const artifactsDir = opts.artifactsDir?.trim() || defaultArtifactsDir;
  const fixtureRefs = parseFixtureRefs(opts.fixture);
  const timeoutMs = parseNumber(opts.waitTimeoutSec, 300) * 1000;
  const pollIntervalMs = parseNumber(opts.pollIntervalMs, 2000);
  const testCase = await loadCaseById(caseId, casesDir);
  ensureRequiredFixtures(testCase, fixtureRefs);
  const judgeVersion = opts.judge === false ? null : CREATE_AGENT_LOCAL_JUDGE_VERSION;
  const benchmarkMetadata = buildCreateAgentBenchmarkMetadata({ testCase, judgeVersion });

  const agentsBefore = await listAgents(ctx.api, ctx.orgId!);
  const approvalsBefore = await listApprovals(ctx.api, ctx.orgId!);
  const issue = await createIssue(ctx.api, ctx.orgId!, {
    title: createBenchmarkIssueTitle(testCase),
    description: appendCreateAgentBenchmarkMetadata(testCase.prompt, benchmarkMetadata),
    assigneeAgentId: benchmarkAgentId,
  });

  const issueWithRun = await waitForIssueExecutionRun(ctx.api, issue.id, timeoutMs, pollIntervalMs);
  const { detail: runDetail, waitTimedOut } = await waitForRunCompletion(
    ctx.api,
    issueWithRun.executionRunId!,
    timeoutMs,
    pollIntervalMs,
  );
  const agentsAfter = await listAgents(ctx.api, ctx.orgId!);
  const approvalsAfter = await listApprovals(ctx.api, ctx.orgId!);
  const createdAgents = await captureCreatedAgents(ctx.api, diffCreatedAgents(agentsBefore, agentsAfter));
  const createdApprovals = await captureCreatedApprovals(ctx.api, diffCreatedApprovals(approvalsBefore, approvalsAfter));

  const provisionalResult: StoredCreateAgentBenchmarkResult = {
    version: "create-agent-benchmark-run-v1",
    generatedAt: new Date().toISOString(),
    runner: {
      waitTimedOut,
      timeoutMs,
    },
    case: testCase,
    fixtureRefs,
    benchmarkMetadata,
    issue: {
      id: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
    },
    runDetail,
    createdAgents,
    createdApprovals,
    evaluation: evaluateCreateAgentBenchmark({
      testCase,
      benchmarkMetadata,
      issueId: issue.id,
      runDetail,
      createdAgents,
      createdApprovals,
      fixtureRefs,
      judge: null,
    }),
  };

  if (opts.judge !== false) {
    provisionalResult.evaluation = evaluateCreateAgentBenchmark({
      testCase,
      benchmarkMetadata: {
        ...benchmarkMetadata,
        judgeVersion: CREATE_AGENT_LOCAL_JUDGE_VERSION,
      },
      issueId: issue.id,
      runDetail,
      createdAgents,
      createdApprovals,
      fixtureRefs,
      judge: await runCreateAgentJudge(provisionalResult, opts.judgeModel),
    });
  }

  const jsonPath = resultJsonPath(artifactsDir, testCase, runDetail.run.id);
  const markdownPath = reportMarkdownPath(artifactsDir, testCase, runDetail.run.id);
  await writeJsonFile(jsonPath, provisionalResult);
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  await fs.writeFile(markdownPath, buildMarkdownReport(provisionalResult), "utf8");
  return provisionalResult;
}

async function rescoreStoredResult(resultPath: string, opts: BenchmarkRescoreOptions): Promise<StoredCreateAgentBenchmarkResult> {
  const result = await readJsonFile<StoredCreateAgentBenchmarkResult>(resultPath);
  const judge = opts.judge === false ? null : await runCreateAgentJudge(result, opts.judgeModel);
  result.evaluation = evaluateCreateAgentBenchmark({
    testCase: result.case,
    benchmarkMetadata: result.benchmarkMetadata,
    issueId: result.issue.id,
    runDetail: result.runDetail,
    createdAgents: result.createdAgents,
    createdApprovals: result.createdApprovals,
    fixtureRefs: result.fixtureRefs,
    judge,
  });
  await writeJsonFile(resultPath, result);
  await fs.writeFile(path.join(path.dirname(resultPath), "report.md"), buildMarkdownReport(result), "utf8");
  return result;
}

function printBenchmarkSummary(result: StoredCreateAgentBenchmarkResult, json = false) {
  if (json) {
    printOutput(result, { json: true });
    return;
  }
  printOutput({
    caseId: result.case.id,
    runId: result.runDetail.run.id,
    runStatus: result.runDetail.run.status,
    waitTimedOut: result.runner?.waitTimedOut ?? false,
    classification: result.evaluation.finalClassification,
    reviewerStatus: result.evaluation.reviewerStatus,
    overall: result.evaluation.checks.create_agent_overall_correctness.value,
    judgeAverage: averageJudgeScore(result.evaluation.judge),
  });
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerCreateAgentBenchmarkCommands(program: Command): void {
  const benchmark = program.command("benchmark").description("Benchmark and evaluation utilities");
  const createAgent = benchmark.command("create-agent").description("Run create-agent benchmark cases");

  addCommonClientOptions(
    createAgent
      .command("run")
      .description("Run one create-agent benchmark case")
      .argument("<caseId>", "Case id from benchmark/create-agent/cases")
      .requiredOption("-O, --org-id <id>", "Organization ID")
      .requiredOption("--benchmark-agent-id <id>", "Agent ID that should execute the benchmark issue")
      .option("--cases-dir <path>", "Override benchmark case directory")
      .option("--artifacts-dir <path>", "Override benchmark artifact directory")
      .option("--fixture <key=value>", "Fixture reference used by the case", collectStringOption, [])
      .option("--wait-timeout-sec <seconds>", "Max wait for run completion", "300")
      .option("--poll-interval-ms <ms>", "Polling interval for issue/run status", "2000")
      .option("--judge-model <model>", "Override the judge model")
      .option("--no-judge", "Skip optional quality judge")
      .action(async (caseId: string, opts: BenchmarkRunOptions) => {
        try {
          const result = await executeBenchmarkCase(caseId, opts);
          printBenchmarkSummary(result, Boolean(opts.json));
        } catch (error) {
          handleCommandError(error);
        }
      }),
  );

  addCommonClientOptions(
    createAgent
      .command("run-set")
      .description("Run a named create-agent benchmark set")
      .argument("<setName>", "Set file name from benchmark/create-agent/sets")
      .requiredOption("-O, --org-id <id>", "Organization ID")
      .requiredOption("--benchmark-agent-id <id>", "Agent ID that should execute the benchmark issue")
      .option("--cases-dir <path>", "Override benchmark case directory")
      .option("--sets-dir <path>", "Override benchmark set directory")
      .option("--artifacts-dir <path>", "Override benchmark artifact directory")
      .option("--fixture <key=value>", "Fixture reference used by the case", collectStringOption, [])
      .option("--wait-timeout-sec <seconds>", "Max wait for run completion", "300")
      .option("--poll-interval-ms <ms>", "Polling interval for issue/run status", "2000")
      .option("--judge-model <model>", "Override the judge model")
      .option("--no-judge", "Skip optional quality judge")
      .option("--continue-on-error", "Continue running the remaining cases after a failure", true)
      .option("--no-continue-on-error", "Stop after the first failed case")
      .action(async (setName: string, opts: BenchmarkRunSetOptions) => {
        try {
          const cases = await loadSet(setName, opts.setsDir?.trim() || defaultSetsDir);
          const summaries: Array<Record<string, unknown>> = [];
          for (const caseId of cases) {
            try {
              const result = await executeBenchmarkCase(caseId, opts);
              summaries.push({
                caseId: result.case.id,
                runId: result.runDetail.run.id,
                classification: result.evaluation.finalClassification,
                reviewerStatus: result.evaluation.reviewerStatus,
              });
            } catch (error) {
              summaries.push({
                caseId,
                error: error instanceof Error ? error.message : String(error),
              });
              if (opts.continueOnError === false) break;
            }
          }
          printOutput(summaries, { json: Boolean(opts.json) });
        } catch (error) {
          handleCommandError(error);
        }
      }),
  );

  addCommonClientOptions(
    createAgent
      .command("rescore")
      .description("Re-run deterministic scoring and optional judge for an existing result.json")
      .argument("<resultPath>", "Path to a stored create-agent benchmark result.json")
      .option("--judge-model <model>", "Override the judge model")
      .option("--no-judge", "Skip optional quality judge")
      .action(async (resultPath: string, opts: BenchmarkRescoreOptions) => {
        try {
          const result = await rescoreStoredResult(path.resolve(resultPath), opts);
          printBenchmarkSummary(result, Boolean(opts.json));
        } catch (error) {
          handleCommandError(error);
        }
      }),
  );

  addCommonClientOptions(
    createAgent
      .command("report")
      .description("Render the markdown summary for an existing result.json")
      .argument("<resultPath>", "Path to a stored create-agent benchmark result.json")
      .option("--markdown", "Print report markdown instead of the parsed result summary", false)
      .action(async (resultPath: string, opts: BenchmarkReportOptions) => {
        try {
          const result = await readJsonFile<StoredCreateAgentBenchmarkResult>(path.resolve(resultPath));
          if (opts.markdown) {
            process.stdout.write(buildMarkdownReport(result));
            return;
          }
          printBenchmarkSummary(result, Boolean(opts.json));
        } catch (error) {
          handleCommandError(error);
        }
      }),
  );
}

function collectStringOption(value: string, previous: string[]) {
  previous.push(value);
  return previous;
}

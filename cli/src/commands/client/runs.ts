import type { HeartbeatRun, HeartbeatRunEvent } from "@rudderhq/shared";
import { Command } from "commander";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface RunsListOptions extends BaseClientOptions {
  updatedAfter?: string;
  runIdPrefix?: string;
  agentId?: string;
  status?: string;
  runtime?: string;
  issueId?: string;
  usedSkill?: string;
  loadedSkill?: string;
  createdBefore?: string;
  limit?: string;
}

interface RunsBySkillOptions extends BaseClientOptions {
  evidence?: string;
  agentId?: string;
  status?: string;
  runtime?: string;
  issueId?: string;
  createdBefore?: string;
  limit?: string;
}

interface RunLogOptions extends BaseClientOptions {
  maxChars?: string;
}

interface RunTranscriptOptions extends BaseClientOptions {
  errorsOnly?: boolean;
  aroundError?: string;
  contextTurns?: string;
  cursor?: string;
  turnLimit?: string;
  chronological?: boolean;
  narrative?: boolean;
  maxChars?: string;
  maxOutputChars?: string;
  includeOutput?: boolean;
  includeOutputs?: boolean;
}

interface RunErrorsOptions extends BaseClientOptions {
  maxChars?: string;
}

interface RunExportRow {
  run: HeartbeatRun;
  agentName: string | null;
  orgName: string | null;
  issue: { id: string; identifier: string | null; title: string | null } | null;
  bundle: { agentRuntimeType: string };
  langfuse?: unknown;
  errorSummary?: string | null;
  skillEvidence?: {
    evidenceType: "used" | "loaded";
    matchedSkillKey: string;
    matchedSkillLabel: string | null;
    sourceEventType: string | null;
    sourceEventId: number | null;
    sourceEventCreatedAt: string | null;
  } | null;
}

interface SkillRunReport {
  skill: {
    query: string;
    evidenceType: "used" | "loaded";
  };
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    timedOut: number;
    running: number;
    queued: number;
    other: number;
    agents: Array<{ id: string; name: string | null; count: number }>;
    issues: Array<{ id: string; identifier: string | null; title: string | null; count: number }>;
    commonErrors: Array<{ summary: string; count: number }>;
  };
  rows: RunExportRow[];
  nextCommands: string[];
}

interface RunTranscriptRow {
  id: string;
  index: number;
  turnIndex: number | null;
  kind: string;
  ts: string;
  label: string;
  preview: string;
  detailPreview: string;
  isError: boolean;
  output: {
    text: string;
    clipped: boolean;
    originalLength: number;
  } | null;
}

interface RunTranscriptEntry {
  id: string;
  index: number;
  turnIndex: number | null;
  entry: unknown;
  output: {
    text: string;
    clipped: false;
    originalLength: number;
  };
}

interface RunTranscriptResponse {
  run: HeartbeatRun;
  agentName: string | null;
  orgName: string | null;
  issue: RunExportRow["issue"];
  order: "newest" | "oldest";
  output: "compact" | "full";
  page: {
    cursor: string | null;
    nextCursor: string | null;
    hasMore: boolean;
    order: "newest" | "oldest";
    turnLimit: number | null;
    returnedSteps: number;
    totalFilteredSteps: number;
  };
  rows: RunTranscriptRow[];
  entries?: RunTranscriptEntry[];
  transcript?: unknown[];
  trace: {
    turnCount: number;
    stepCount: number;
    payloadStepCount: number;
    filteredStepCount?: number;
  };
}

interface RunErrorRow {
  id: string;
  type: string;
  index: number | null;
  turnIndex: number | null;
  ts: string | null;
  summary: string;
  output: {
    text: string;
    clipped: boolean;
    originalLength: number;
  };
  transcriptContext: {
    id: string;
    command: string;
  } | null;
}

interface RunErrorsResponse {
  run: HeartbeatRun;
  agentName: string | null;
  orgName: string | null;
  issue: RunExportRow["issue"];
  errors: RunErrorRow[];
}

export function registerRunsCommands(program: Command): void {
  const runs = program.command("runs").description("Run debugging operations");

  addCommonClientOptions(
    runs
      .command("list")
      .description(getAgentCliCapabilityById("runs.list").description)
      .option("-O, --org-id <id>", "Organization ID")
      .option("--updated-after <iso>", "Only runs updated after this timestamp")
      .option("--run-id-prefix <prefix>", "Filter by run ID prefix")
      .option("--agent-id <id>", "Filter by agent ID")
      .option("--status <status>", "Filter by run status")
      .option("--runtime <type>", "Filter by runtime type")
      .option("--issue-id <id>", "Filter by linked issue ID")
      .option("--used-skill <key-or-name>", "Filter by skill actually used during the run")
      .option("--loaded-skill <key-or-name>", "Filter by skill loaded for the run")
      .option("--created-before <iso>", "Only runs created before this timestamp")
      .option("--limit <n>", "Maximum rows", "200")
      .action(async (opts: RunsListOptions) => {
        try {
          assertSingleSkillFilter(opts);
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<RunExportRow[]>(`/api/run-intelligence/orgs/${ctx.orgId}/runs?${buildRunsListQuery(opts)}`)) ?? [];
          printOutput(ctx.json ? rows : rows.map(formatRunListRow), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    runs
      .command("by-skill")
      .description(getAgentCliCapabilityById("runs.by-skill").description)
      .argument("<skill>", "Skill key or display name")
      .option("-O, --org-id <id>", "Organization ID")
      .option("--evidence <used|loaded>", "Evidence type to match; defaults to used", "used")
      .option("--agent-id <id>", "Filter by agent ID")
      .option("--status <status>", "Filter by run status")
      .option("--runtime <type>", "Filter by runtime type")
      .option("--issue-id <id>", "Filter by linked issue ID")
      .option("--created-before <iso>", "Only runs created before this timestamp")
      .option("--limit <n>", "Maximum rows", "50")
      .action(async (skill: string, opts: RunsBySkillOptions) => {
        try {
          const evidenceType = parseSkillEvidenceType(opts.evidence);
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = buildRunsBySkillQuery(skill, opts, evidenceType);
          const rows = (await ctx.api.get<RunExportRow[]>(`/api/run-intelligence/orgs/${ctx.orgId}/runs?${params}`)) ?? [];
          const report = buildSkillRunReport(skill, evidenceType, rows);
          printOutput(ctx.json ? report : formatSkillRunReport(report), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    runs
      .command("get")
      .description(getAgentCliCapabilityById("runs.get").description)
      .argument("<runId>", "Run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<RunExportRow>(`/api/run-intelligence/runs/${encodeURIComponent(runId)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    runs
      .command("events")
      .description(getAgentCliCapabilityById("runs.events").description)
      .argument("<runId>", "Run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<HeartbeatRunEvent[]>(`/api/run-intelligence/runs/${encodeURIComponent(runId)}/events`)) ?? [];
          printOutput(ctx.json ? rows : rows.map(formatRunEvent), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    runs
      .command("log")
      .description(getAgentCliCapabilityById("runs.log").description)
      .argument("<runId>", "Run ID")
      .option("--max-chars <n>", "Maximum log characters for human output", "12000")
      .action(async (runId: string, opts: RunLogOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<{ content: string }>(`/api/run-intelligence/runs/${encodeURIComponent(runId)}/log`);
          if (ctx.json) {
            printOutput(row, { json: true });
          } else {
            process.stdout.write(clip(row?.content ?? "", parseLimit(opts.maxChars, 12000)) + "\n");
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    runs
      .command("transcript")
      .description(getAgentCliCapabilityById("runs.transcript").description)
      .argument("<runId>", "Run ID")
      .option("--errors-only", "Show only error transcript rows")
      .option("--around-error <id>", "Show context around a run error id such as step-12")
      .option("--context-turns <n>", "Turns around --around-error", "1")
      .option("--cursor <cursor>", "Stable transcript cursor returned in page.nextCursor")
      .option("--turn-limit <n>", "Maximum turns to return", "20")
      .option("--chronological", "Show oldest-first instead of default newest-first")
      .option("--narrative", "Use a narrative human layout")
      .option("--max-chars <n>", "Maximum output characters per row", "1200")
      .option("--max-output-chars <n>", "Alias for --max-chars")
      .option("--include-output", "Include row output in compact human transcript rows")
      .option("--include-outputs", "Alias for --include-output")
      .action(async (runId: string, opts: RunTranscriptOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = await ctx.api.get<RunTranscriptResponse>(
            `/api/run-intelligence/runs/${encodeURIComponent(runId)}/transcript?${buildTranscriptQuery(opts, { json: ctx.json })}`,
          );
          if (ctx.json) {
            printOutput(payload, { json: true });
          } else if (opts.narrative) {
            printOutput((payload?.rows ?? []).map(formatRunTranscriptNarrative), { json: false });
          } else {
            printOutput((payload?.rows ?? []).map(formatRunTranscriptRow), { json: false });
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    runs
      .command("errors")
      .description(getAgentCliCapabilityById("runs.errors").description)
      .argument("<runId>", "Run ID")
      .option("--max-chars <n>", "Maximum output characters per error", "1200")
      .action(async (runId: string, opts: RunErrorsOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          params.set("maxChars", String(parseLimit(opts.maxChars, 1200)));
          const payload = await ctx.api.get<RunErrorsResponse>(
            `/api/run-intelligence/runs/${encodeURIComponent(runId)}/errors?${params.toString()}`,
          );
          printOutput(ctx.json ? payload : (payload?.errors ?? []).map(formatRunError), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    runs
      .command("cancel")
      .description(getAgentCliCapabilityById("runs.cancel").description)
      .argument("<runId>", "Run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<HeartbeatRun>(`/api/heartbeat-runs/${encodeURIComponent(runId)}/cancel`, {});
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    runs
      .command("retry")
      .description(getAgentCliCapabilityById("runs.retry").description)
      .argument("<runId>", "Run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<HeartbeatRun>(`/api/heartbeat-runs/${encodeURIComponent(runId)}/retry`, {});
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function buildRunsListQuery(opts: RunsListOptions) {
  const params = new URLSearchParams();
  if (opts.updatedAfter) params.set("updatedAfter", opts.updatedAfter);
  if (opts.runIdPrefix) params.set("runIdPrefix", opts.runIdPrefix);
  if (opts.agentId) params.set("agentId", opts.agentId);
  if (opts.status) params.set("status", opts.status);
  if (opts.runtime) params.set("runtime", opts.runtime);
  if (opts.issueId) params.set("issueId", opts.issueId);
  if (opts.usedSkill) params.set("usedSkill", opts.usedSkill);
  if (opts.loadedSkill) params.set("loadedSkill", opts.loadedSkill);
  if (opts.createdBefore) params.set("createdBefore", opts.createdBefore);
  if (opts.limit) params.set("limit", opts.limit);
  return params.toString();
}

function buildRunsBySkillQuery(skill: string, opts: RunsBySkillOptions, evidenceType: "used" | "loaded") {
  const params = new URLSearchParams();
  params.set(evidenceType === "used" ? "usedSkill" : "loadedSkill", skill);
  if (opts.agentId) params.set("agentId", opts.agentId);
  if (opts.status) params.set("status", opts.status);
  if (opts.runtime) params.set("runtime", opts.runtime);
  if (opts.issueId) params.set("issueId", opts.issueId);
  if (opts.createdBefore) params.set("createdBefore", opts.createdBefore);
  if (opts.limit) params.set("limit", opts.limit);
  return params.toString();
}

function assertSingleSkillFilter(opts: RunsListOptions) {
  if (opts.usedSkill && opts.loadedSkill) {
    throw new Error("Use either --used-skill or --loaded-skill, not both.");
  }
}

function parseSkillEvidenceType(value: string | undefined): "used" | "loaded" {
  const normalized = (value ?? "used").trim().toLowerCase();
  if (normalized === "used" || normalized === "loaded") return normalized;
  throw new Error("--evidence must be either 'used' or 'loaded'.");
}

function buildTranscriptQuery(opts: RunTranscriptOptions, output: { json: boolean }) {
  const params = new URLSearchParams();
  if (opts.errorsOnly) params.set("errorsOnly", "true");
  if (opts.aroundError) params.set("aroundError", opts.aroundError);
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.turnLimit) params.set("turnLimit", String(parseLimit(opts.turnLimit, 20)));
  params.set("contextTurns", String(parseLimit(opts.contextTurns, 1)));
  params.set("order", opts.chronological || opts.narrative ? "oldest" : "newest");
  params.set("output", output.json ? "full" : "compact");
  const includeOutputs = output.json || Boolean(opts.includeOutput || opts.includeOutputs || opts.narrative);
  params.set("includeOutputs", includeOutputs ? "true" : "false");
  params.set("maxChars", String(parseLimit(opts.maxOutputChars ?? opts.maxChars, 1200)));
  return params.toString();
}

function formatRunListRow(row: RunExportRow) {
  return {
    id: row.run.id,
    status: row.run.status,
    agent: row.agentName ?? row.run.agentId,
    runtime: row.bundle.agentRuntimeType,
    issue: formatIssueRef(row.issue),
    createdAt: row.run.createdAt,
    finishedAt: row.run.finishedAt ?? "-",
    evidence: row.skillEvidence?.evidenceType ?? "-",
    skill: row.skillEvidence?.matchedSkillKey ?? "-",
    langfuse: readLangfuseTraceUrl(row.langfuse) ?? "-",
    error: row.errorSummary ?? "-",
    next: row.run.status === "failed" ? `rudder runs errors ${row.run.id}` : `rudder runs transcript ${row.run.id}`,
  };
}

function buildSkillRunReport(skill: string, evidenceType: "used" | "loaded", rows: RunExportRow[]): SkillRunReport {
  const statusCounts = {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    running: 0,
    queued: 0,
    other: 0,
  };
  const agents = new Map<string, { id: string; name: string | null; count: number }>();
  const issues = new Map<string, { id: string; identifier: string | null; title: string | null; count: number }>();
  const errors = new Map<string, number>();

  for (const row of rows) {
    const status = row.run.status;
    if (status === "succeeded") statusCounts.succeeded += 1;
    else if (status === "failed") statusCounts.failed += 1;
    else if (status === "cancelled") statusCounts.cancelled += 1;
    else if (status === "timed_out") statusCounts.timedOut += 1;
    else if (status === "running") statusCounts.running += 1;
    else if (status === "queued") statusCounts.queued += 1;
    else statusCounts.other += 1;

    const agent = agents.get(row.run.agentId) ?? { id: row.run.agentId, name: row.agentName, count: 0 };
    agent.count += 1;
    agents.set(agent.id, agent);

    if (row.issue) {
      const issue = issues.get(row.issue.id) ?? { ...row.issue, count: 0 };
      issue.count += 1;
      issues.set(issue.id, issue);
    }

    const error = row.errorSummary?.trim();
    if (error) errors.set(error, (errors.get(error) ?? 0) + 1);
  }

  return {
    skill: { query: skill, evidenceType },
    summary: {
      total: rows.length,
      ...statusCounts,
      agents: [...agents.values()].sort((a, b) => b.count - a.count),
      issues: [...issues.values()].sort((a, b) => b.count - a.count),
      commonErrors: [...errors.entries()]
        .map(([summary, count]) => ({ summary, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    },
    rows,
    nextCommands: rows.slice(0, 5).map((row) =>
      row.run.status === "failed"
        ? `rudder runs errors ${row.run.id}`
        : `rudder runs transcript ${row.run.id}`),
  };
}

function formatSkillRunReport(report: SkillRunReport) {
  const lines = [
    `skill=${report.skill.query} evidence=${report.skill.evidenceType} total=${report.summary.total} succeeded=${report.summary.succeeded} failed=${report.summary.failed} cancelled=${report.summary.cancelled} timedOut=${report.summary.timedOut}`,
  ];
  if (report.summary.agents.length > 0) {
    lines.push(`agents=${report.summary.agents.map((agent) => `${agent.name ?? agent.id}:${agent.count}`).join(", ")}`);
  }
  if (report.summary.issues.length > 0) {
    lines.push(`issues=${report.summary.issues.map((issue) => `${issue.identifier ?? issue.id}:${issue.count}`).join(", ")}`);
  }
  if (report.summary.commonErrors.length > 0) {
    lines.push(`commonErrors=${report.summary.commonErrors.map((error) => `${clip(error.summary, 80)}:${error.count}`).join(" | ")}`);
  }
  lines.push(...report.rows.map((row) => formatInlineSkillRun(row)));
  if (report.nextCommands.length > 0) {
    lines.push("next:");
    lines.push(...report.nextCommands.map((command) => `  ${command}`));
  }
  return lines;
}

function formatInlineSkillRun(row: RunExportRow) {
  const issue = formatIssueRef(row.issue);
  const label = row.skillEvidence?.matchedSkillLabel && row.skillEvidence.matchedSkillLabel !== row.skillEvidence.matchedSkillKey
    ? ` label=${row.skillEvidence.matchedSkillLabel}`
    : "";
  const langfuse = readLangfuseTraceUrl(row.langfuse);
  return [
    `id=${row.run.id}`,
    `status=${row.run.status}`,
    `agent=${row.agentName ?? row.run.agentId}`,
    `issue=${issue}`,
    `runtime=${row.bundle.agentRuntimeType}`,
    `createdAt=${row.run.createdAt}`,
    `finishedAt=${row.run.finishedAt ?? "-"}`,
    `evidence=${row.skillEvidence?.evidenceType ?? "-"}`,
    `skill=${row.skillEvidence?.matchedSkillKey ?? "-"}${label}`,
    `langfuse=${langfuse ?? "-"}`,
    `error=${row.errorSummary ?? "-"}`,
    `next=${row.run.status === "failed" ? `rudder runs errors ${row.run.id}` : `rudder runs transcript ${row.run.id}`}`,
  ].join(" ");
}

function formatIssueRef(issue: RunExportRow["issue"]) {
  if (!issue) return "-";
  return issue.identifier && issue.title ? `${issue.identifier} ${issue.title}` : issue.identifier ?? issue.title ?? issue.id;
}

function readLangfuseTraceUrl(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const traceUrl = (value as { traceUrl?: unknown }).traceUrl;
  return typeof traceUrl === "string" && traceUrl.length > 0 ? traceUrl : null;
}

function formatRunEvent(row: HeartbeatRunEvent) {
  return {
    seq: row.seq,
    level: row.level,
    stream: row.stream,
    message: row.message,
    createdAt: row.createdAt,
  };
}

function formatRunTranscriptRow(row: RunTranscriptRow) {
  return {
    id: row.id,
    turn: row.turnIndex ?? "-",
    kind: row.kind,
    ts: row.ts,
    error: row.isError ? "yes" : "no",
    preview: row.preview || row.detailPreview,
    ...(row.output ? { output: row.output.text } : {}),
  };
}

function formatRunTranscriptNarrative(row: RunTranscriptRow) {
  const marker = row.isError ? "ERROR " : "";
  return `${row.id} ${row.ts} ${marker}${row.kind}: ${row.preview || row.detailPreview}${row.output ? `\n${row.output.text}` : ""}`;
}

function formatRunError(row: RunErrorRow) {
  return {
    id: row.id,
    type: row.type,
    turn: row.turnIndex ?? "-",
    summary: row.summary,
    output: row.output.text,
    context: row.transcriptContext?.command ?? "-",
  };
}

function parseLimit(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function clip(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

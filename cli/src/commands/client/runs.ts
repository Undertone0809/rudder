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
      .option("--created-before <iso>", "Only runs created before this timestamp")
      .option("--limit <n>", "Maximum rows", "200")
      .action(async (opts: RunsListOptions) => {
        try {
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
  if (opts.createdBefore) params.set("createdBefore", opts.createdBefore);
  if (opts.limit) params.set("limit", opts.limit);
  return params.toString();
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
    issue: row.issue?.identifier ?? row.issue?.id ?? "-",
    updatedAt: row.run.updatedAt,
  };
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

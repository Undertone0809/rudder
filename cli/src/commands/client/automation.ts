import {
  createAutomationSchema,
  createAutomationTriggerSchema,
  rotateAutomationTriggerSecretSchema,
  runAutomationSchema,
  updateAutomationSchema,
  updateAutomationTriggerSchema,
  type AutomationDetail,
  type AutomationListItem,
  type AutomationRun,
  type AutomationRunSummary,
  type AutomationTrigger,
  type AutomationTriggerSecretMaterial,
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
import { formatExamplesAndCautions } from "./help.js";

interface AutomationListOptions extends BaseClientOptions {
  status?: string;
  assigneeAgentId?: string;
  projectId?: string;
  outputMode?: string;
}

interface AutomationCreateOptions extends BaseClientOptions {
  payload?: string;
  title?: string;
  instructions?: string;
  description?: string;
  assigneeAgentId?: string;
  projectId?: string;
  goalId?: string;
  parentIssueId?: string;
  priority?: string;
  status?: string;
  outputMode?: string;
  concurrencyPolicy?: string;
  catchUpPolicy?: string;
  notifyOnIssueCreated?: boolean;
}

interface AutomationUpdateOptions extends AutomationCreateOptions {}

interface AutomationRunsOptions extends BaseClientOptions {
  limit?: string;
}

interface AutomationRunOptions extends BaseClientOptions {
  triggerId?: string;
  payload?: string;
  idempotencyKey?: string;
  source?: string;
}

interface AutomationTriggerCreateOptions extends BaseClientOptions {
  payload?: string;
  kind?: string;
  label?: string;
  enabled?: boolean;
  disabled?: boolean;
  cronExpression?: string;
  timezone?: string;
  signingMode?: string;
  replayWindowSec?: string;
}

interface AutomationTriggerUpdateOptions extends Omit<AutomationTriggerCreateOptions, "kind"> {}

interface AutomationTriggerMutationResult {
  trigger: AutomationTrigger;
  secretMaterial: AutomationTriggerSecretMaterial | null;
}

export function registerAutomationCommands(program: Command): void {
  const automation = program.command("automation").description("Automation operations");
  const triggers = automation.command("triggers").description("Automation trigger operations");

  addCommonClientOptions(
    automation
      .command("list")
      .description(getAgentCliCapabilityById("automation.list").description)
      .option("-O, --org-id <id>", "Organization ID")
      .option("--status <status>", "Filter by automation status")
      .option("--assignee-agent-id <id>", "Filter by assignee agent ID")
      .option("--project-id <id>", "Filter by project ID")
      .option("--output-mode <mode>", "Filter by output mode")
      .action(async (opts: AutomationListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<AutomationListItem[]>(`/api/orgs/${ctx.orgId}/automations`)) ?? [];
          const filtered = rows.filter((row) =>
            (!opts.status || row.status === opts.status) &&
            (!opts.assigneeAgentId || row.assigneeAgentId === opts.assigneeAgentId) &&
            (!opts.projectId || row.projectId === opts.projectId) &&
            (!opts.outputMode || row.outputMode === opts.outputMode),
          );
          printOutput(ctx.json ? filtered : filtered.map(formatAutomationListItem), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    automation
      .command("get")
      .description(getAgentCliCapabilityById("automation.get").description)
      .argument("<automationId>", "Automation ID")
      .action(async (automationId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<AutomationDetail>(`/api/automations/${encodeURIComponent(automationId)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    automation
      .command("runs")
      .description(getAgentCliCapabilityById("automation.runs").description)
      .argument("<automationId>", "Automation ID")
      .option("--limit <n>", "Maximum runs to return", "50")
      .action(async (automationId: string, opts: AutomationRunsOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.limit) params.set("limit", opts.limit);
          const rows = (await ctx.api.get<AutomationRunSummary[]>(
            `/api/automations/${encodeURIComponent(automationId)}/runs?${params.toString()}`,
          )) ?? [];
          printOutput(ctx.json ? rows : rows.map(formatAutomationRun), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    triggers
      .command("list")
      .description(getAgentCliCapabilityById("automation.triggers.list").description)
      .argument("<automationId>", "Automation ID")
      .action(async (automationId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<AutomationDetail>(`/api/automations/${encodeURIComponent(automationId)}`);
          const triggers = row?.triggers ?? [];
          printOutput(triggers, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    triggers
      .command("create")
      .description(getAgentCliCapabilityById("automation.triggers.create").description)
      .argument("<automationId>", "Automation ID")
      .option("--payload <json>", "Raw automation trigger create payload JSON")
      .option("--kind <kind>", "Trigger kind: schedule, webhook, or api")
      .option("--label <label>", "Trigger label")
      .option("--enabled", "Create the trigger enabled")
      .option("--disabled", "Create the trigger disabled")
      .option("--cron-expression <expr>", "Schedule cron expression")
      .option("--timezone <timezone>", "Schedule timezone; defaults to UTC for schedule triggers")
      .option("--signing-mode <mode>", "Webhook signing mode")
      .option("--replay-window-sec <seconds>", "Webhook replay window in seconds")
      .action(async (automationId: string, opts: AutomationTriggerCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createAutomationTriggerSchema.parse(buildAutomationTriggerPayload(opts));
          const created = await ctx.api.post<AutomationTriggerMutationResult>(
            `/api/automations/${encodeURIComponent(automationId)}/triggers`,
            payload,
          );
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    triggers
      .command("update")
      .description(getAgentCliCapabilityById("automation.triggers.update").description)
      .argument("<triggerId>", "Automation trigger ID")
      .option("--payload <json>", "Raw automation trigger update payload JSON")
      .option("--label <label>", "Trigger label")
      .option("--enabled", "Enable the trigger")
      .option("--disabled", "Disable the trigger")
      .option("--cron-expression <expr>", "Schedule cron expression")
      .option("--timezone <timezone>", "Schedule timezone")
      .option("--signing-mode <mode>", "Webhook signing mode")
      .option("--replay-window-sec <seconds>", "Webhook replay window in seconds")
      .action(async (triggerId: string, opts: AutomationTriggerUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAutomationTriggerSchema.parse(buildAutomationTriggerPayload(opts));
          const updated = await ctx.api.patch<AutomationTrigger>(
            `/api/automation-triggers/${encodeURIComponent(triggerId)}`,
            payload,
          );
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    triggers
      .command("delete")
      .description(getAgentCliCapabilityById("automation.triggers.delete").description)
      .argument("<triggerId>", "Automation trigger ID")
      .action(async (triggerId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          await ctx.api.delete(`/api/automation-triggers/${encodeURIComponent(triggerId)}`);
          printOutput({ id: triggerId, deleted: true }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    triggers
      .command("rotate-secret")
      .description(getAgentCliCapabilityById("automation.triggers.rotate-secret").description)
      .argument("<triggerId>", "Automation trigger ID")
      .action(async (triggerId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = rotateAutomationTriggerSecretSchema.parse({});
          const rotated = await ctx.api.post<AutomationTriggerMutationResult>(
            `/api/automation-triggers/${encodeURIComponent(triggerId)}/rotate-secret`,
            payload,
          );
          printOutput(rotated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    automation
      .command("create")
      .description(getAgentCliCapabilityById("automation.create").description)
      .option("-O, --org-id <id>", "Organization ID")
      .option("--payload <json>", "Raw automation create payload JSON")
      .option("--title <title>", "Automation title")
      .option("--instructions <text>", "Automation run instructions")
      .option("--description <text>", "Deprecated alias for --instructions")
      .option("--assignee-agent-id <id>", "Assignee agent ID")
      .option("--project-id <id>", "Project ID")
      .option("--goal-id <id>", "Goal ID")
      .option("--parent-issue-id <id>", "Parent issue ID")
      .option("--priority <priority>", "Issue priority for tracked output")
      .option("--status <status>", "Automation status")
      .option("--output-mode <mode>", "Automation output mode")
      .option("--concurrency-policy <policy>", "Automation concurrency policy")
      .option("--catch-up-policy <policy>", "Automation catch-up policy")
      .option("--notify-on-issue-created", "Notify when tracked issue output is created")
      .action(async (opts: AutomationCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createAutomationSchema.parse(buildAutomationPayload(opts));
          const created = await ctx.api.post<AutomationDetail>(`/api/orgs/${ctx.orgId}/automations`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    automation
      .command("update")
      .description(getAgentCliCapabilityById("automation.update").description)
      .argument("<automationId>", "Automation ID")
      .option("--payload <json>", "Raw automation update payload JSON")
      .option("--title <title>", "Automation title")
      .option("--instructions <text>", "Automation run instructions")
      .option("--description <text>", "Deprecated alias for --instructions")
      .option("--assignee-agent-id <id>", "Assignee agent ID")
      .option("--project-id <id>", "Project ID")
      .option("--goal-id <id>", "Goal ID")
      .option("--parent-issue-id <id>", "Parent issue ID")
      .option("--priority <priority>", "Issue priority for tracked output")
      .option("--status <status>", "Automation status")
      .option("--output-mode <mode>", "Automation output mode")
      .option("--concurrency-policy <policy>", "Automation concurrency policy")
      .option("--catch-up-policy <policy>", "Automation catch-up policy")
      .option("--notify-on-issue-created", "Notify when tracked issue output is created")
      .action(async (automationId: string, opts: AutomationUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAutomationSchema.parse(buildAutomationPayload(opts));
          const updated = await ctx.api.patch<AutomationDetail>(`/api/automations/${encodeURIComponent(automationId)}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    automation
      .command("enable")
      .description(getAgentCliCapabilityById("automation.enable").description)
      .argument("<automationId>", "Automation ID")
      .action(async (automationId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const updated = await ctx.api.patch<AutomationDetail>(`/api/automations/${encodeURIComponent(automationId)}`, {
            status: "active",
          });
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    automation
      .command("disable")
      .description(getAgentCliCapabilityById("automation.disable").description)
      .argument("<automationId>", "Automation ID")
      .action(async (automationId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const updated = await ctx.api.patch<AutomationDetail>(`/api/automations/${encodeURIComponent(automationId)}`, {
            status: "paused",
          });
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    automation
      .command("run")
      .description(getAgentCliCapabilityById("automation.run").description)
      .argument("<automationId>", "Automation ID")
      .option("--trigger-id <id>", "Trigger ID")
      .option("--payload <json>", "Manual run payload JSON")
      .option("--idempotency-key <key>", "Idempotency key")
      .option("--source <source>", "Run source", "manual")
      .addHelpText("after", formatExamplesAndCautions({
        examples: [
          "rudder automation run <automation-id> --payload '{\"manual\":true}' --json",
          "rudder automation run <automation-id> --trigger-id <trigger-id> --idempotency-key zst-123-smoke",
        ],
        cautions: [
          "Confirm the automation and trigger target before running; manual runs can create tracked issues or chats.",
          "Use an idempotency key for retried manual invocations so duplicate work is easier to detect.",
        ],
      }))
      .action(async (automationId: string, opts: AutomationRunOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = runAutomationSchema.parse({
            triggerId: opts.triggerId,
            payload: opts.payload ? parseJsonOption(opts.payload, "--payload") : undefined,
            idempotencyKey: opts.idempotencyKey,
            source: opts.source,
          });
          const run = await ctx.api.post<AutomationRun>(`/api/automations/${encodeURIComponent(automationId)}/run`, payload);
          printOutput(run, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function buildAutomationPayload(opts: AutomationCreateOptions | AutomationUpdateOptions) {
  return {
    ...parseJsonObjectOption(opts.payload, "--payload"),
    ...definedRecord({
      title: opts.title,
      instructions: opts.instructions ?? opts.description,
      assigneeAgentId: opts.assigneeAgentId,
      projectId: opts.projectId,
      goalId: opts.goalId,
      parentIssueId: opts.parentIssueId,
      priority: opts.priority,
      status: opts.status,
      outputMode: opts.outputMode,
      concurrencyPolicy: opts.concurrencyPolicy,
      catchUpPolicy: opts.catchUpPolicy,
      notifyOnIssueCreated: opts.notifyOnIssueCreated,
    }),
  };
}

function buildAutomationTriggerPayload(opts: AutomationTriggerCreateOptions | AutomationTriggerUpdateOptions) {
  return {
    ...parseJsonObjectOption(opts.payload, "--payload"),
    ...definedRecord({
      kind: "kind" in opts ? opts.kind : undefined,
      label: opts.label,
      enabled: parseEnabledOption(opts),
      cronExpression: opts.cronExpression,
      timezone: opts.timezone,
      signingMode: opts.signingMode,
      replayWindowSec: parseOptionalIntegerOption(opts.replayWindowSec, "--replay-window-sec"),
    }),
  };
}

function parseEnabledOption(opts: { enabled?: boolean; disabled?: boolean }): boolean | undefined {
  if (opts.enabled && opts.disabled) {
    throw new Error("Pass only one of --enabled or --disabled");
  }
  if (opts.enabled) return true;
  if (opts.disabled) return false;
  return undefined;
}

function parseOptionalIntegerOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

function definedRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function parseJsonOption(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON`);
  }
}

function parseJsonObjectOption(value: string | undefined, label: string): Record<string, unknown> {
  if (!value) return {};
  const parsed = parseJsonOption(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function formatAutomationListItem(row: AutomationListItem) {
  const nextRunAt = row.triggers
    .map((trigger) => trigger.nextRunAt)
    .filter(Boolean)
    .sort()[0] ?? null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assigneeAgentId: row.assigneeAgentId,
    outputMode: row.outputMode,
    lastRun: row.lastRun?.status ?? "-",
    nextRunAt,
  };
}

function formatAutomationRun(row: AutomationRunSummary) {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    triggeredAt: row.triggeredAt,
    linkedIssue: row.linkedIssue?.identifier ?? row.linkedIssueId ?? "-",
    linkedChatConversationId: row.linkedChatConversationId ?? "-",
    failureReason: row.failureReason ?? "-",
  };
}

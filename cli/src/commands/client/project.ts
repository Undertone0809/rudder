import {
  createProjectSchema,
  updateProjectSchema,
  type Project,
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

interface ProjectListOptions extends BaseClientOptions {}

interface ProjectCreateOptions extends BaseClientOptions {
  name: string;
  description?: string;
  status?: string;
  goalId?: string;
  goalIds?: string;
  leadAgentId?: string;
  targetDate?: string;
  color?: string;
}

interface ProjectUpdateOptions extends BaseClientOptions {
  name?: string;
  description?: string;
  status?: string;
  goalId?: string;
  goalIds?: string;
  leadAgentId?: string;
  targetDate?: string;
  color?: string;
  archivedAt?: string;
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Project operations");

  addCommonClientOptions(
    project
      .command("list")
      .description(getAgentCliCapabilityById("project.list").description)
      .option("-O, --org-id <id>", "Organization ID")
      .action(async (opts: ProjectListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Project[]>(`/api/orgs/${ctx.orgId}/projects`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("get")
      .description(getAgentCliCapabilityById("project.get").description)
      .argument("<projectIdOrShortname>", "Project ID or shortname")
      .option("-O, --org-id <id>", "Organization ID for shortname resolution")
      .action(async (projectRef: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Project>(projectPath(projectRef, ctx.orgId));
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("create")
      .description(getAgentCliCapabilityById("project.create").description)
      .option("-O, --org-id <id>", "Organization ID")
      .requiredOption("--name <name>", "Project name")
      .option("--description <text>", "Project description")
      .option("--status <status>", "Project status")
      .option("--goal-id <id>", "Primary goal ID")
      .option("--goal-ids <csv>", "Comma-separated goal IDs")
      .option("--lead-agent-id <id>", "Lead agent ID")
      .option("--target-date <date>", "Target date")
      .option("--color <value>", "Project color or supported gradient token")
      .action(async (opts: ProjectCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createProjectSchema.parse({
            name: opts.name,
            description: opts.description,
            status: opts.status,
            goalId: opts.goalId,
            goalIds: parseCsv(opts.goalIds),
            leadAgentId: opts.leadAgentId,
            targetDate: opts.targetDate,
            color: opts.color,
          });
          const created = await ctx.api.post<Project>(`/api/orgs/${ctx.orgId}/projects`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("update")
      .description(getAgentCliCapabilityById("project.update").description)
      .argument("<projectIdOrShortname>", "Project ID or shortname")
      .option("-O, --org-id <id>", "Organization ID for shortname resolution")
      .option("--name <name>", "Project name")
      .option("--description <text>", "Project description")
      .option("--status <status>", "Project status")
      .option("--goal-id <id>", "Primary goal ID")
      .option("--goal-ids <csv>", "Comma-separated goal IDs")
      .option("--lead-agent-id <id>", "Lead agent ID")
      .option("--target-date <date>", "Target date")
      .option("--color <value>", "Project color or supported gradient token")
      .option("--archived-at <iso8601|null>", "Set archivedAt timestamp or literal 'null'")
      .action(async (projectRef: string, opts: ProjectUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateProjectSchema.parse({
            name: opts.name,
            description: opts.description,
            status: opts.status,
            goalId: opts.goalId,
            goalIds: parseCsv(opts.goalIds),
            leadAgentId: opts.leadAgentId,
            targetDate: opts.targetDate,
            color: opts.color,
            archivedAt: parseNullableOption(opts.archivedAt),
          });
          const updated = await ctx.api.patch<Project>(projectPath(projectRef, ctx.orgId), payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseNullableOption(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === "null" ? null : value;
}

function projectPath(projectRef: string, orgId: string | undefined): string {
  const params = new URLSearchParams();
  if (orgId) params.set("orgId", orgId);
  const query = params.toString();
  return `/api/projects/${encodeURIComponent(projectRef)}${query ? `?${query}` : ""}`;
}

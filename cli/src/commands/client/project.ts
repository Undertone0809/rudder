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
import { formatExamplesAndCautions } from "./help.js";

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
      .addHelpText("after", formatExamplesAndCautions({
        examples: [
          {
            description: "Create a new active workstream after confirming it does not already exist:",
            command: "rudder project create --org-id <org-id> --name \"Rudder dev\" --status in_progress --json",
          },
          {
            description: "Create a project tied to a goal and responsible agent:",
            command: "rudder project create --org-id <org-id> --name \"Release\" --goal-id <goal-id> --lead-agent-id <agent-id>",
          },
        ],
        cautions: [
          "Project mutations are organization-scoped; pass --org-id when context might be ambiguous.",
          "Use existing project IDs/shortnames for updates instead of creating duplicate project containers.",
        ],
      }))
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
      .addHelpText("after", formatExamplesAndCautions({
        examples: [
          {
            description: "Move a known project shortname under the intended org:",
            command: "rudder project update rudder-dev --org-id <org-id> --status in_progress --json",
          },
          {
            description: "Unarchive a verified project id:",
            command: "rudder project update <project-id> --archived-at null",
          },
        ],
        cautions: [
          "Shortname resolution needs the intended organization; include --org-id for cross-org local contexts.",
          "Archiving and unarchiving changes project visibility, so verify the target with project get first.",
        ],
      }))
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

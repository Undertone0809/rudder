import { Command } from "commander";
import {
  organizationSkillImportSchema,
  organizationSkillLocalScanRequestSchema,
  organizationSkillProjectScanRequestSchema,
  type OrganizationSkillDetail,
  type OrganizationSkillFileDetail,
  type OrganizationSkillImportResult,
  type OrganizationSkillListItem,
  type OrganizationSkillLocalScanResult,
  type OrganizationSkillProjectScanResult,
} from "@rudder/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";

interface SkillListOptions extends BaseClientOptions {
  orgId?: string;
}

interface SkillImportOptions extends BaseClientOptions {
  orgId?: string;
  source: string;
}

interface SkillFileOptions extends BaseClientOptions {
  orgId?: string;
  path?: string;
}

interface SkillScanLocalOptions extends BaseClientOptions {
  orgId?: string;
  roots?: string;
}

interface SkillScanProjectsOptions extends BaseClientOptions {
  orgId?: string;
  projectIds?: string;
  workspaceIds?: string;
}

export function registerSkillCommands(program: Command): void {
  const skill = program.command("skill").description("Organization skill library operations");

  addCommonClientOptions(
    skill
      .command("list")
      .description(getAgentCliCapabilityById("skill.list").description)
      .option("-O, --org-id <id>", "Organization ID")
      .action(async (opts: SkillListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<OrganizationSkillListItem[]>(`/api/orgs/${ctx.orgId}/skills`)) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                key: row.key,
                slug: row.slug,
                name: row.name,
                sourceBadge: row.sourceBadge,
                compatibility: row.compatibility,
                attachedAgentCount: row.attachedAgentCount,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("get")
      .description(getAgentCliCapabilityById("skill.get").description)
      .argument("<skillId>", "Skill ID")
      .option("-O, --org-id <id>", "Organization ID")
      .action(async (skillId: string, opts: SkillListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<OrganizationSkillDetail>(`/api/orgs/${ctx.orgId}/skills/${skillId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("file")
      .description(getAgentCliCapabilityById("skill.file").description)
      .argument("<skillId>", "Skill ID")
      .option("-O, --org-id <id>", "Organization ID")
      .option("--path <path>", "Skill package file path", "SKILL.md")
      .action(async (skillId: string, opts: SkillFileOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams({ path: opts.path ?? "SKILL.md" });
          const row = await ctx.api.get<OrganizationSkillFileDetail>(
            `/api/orgs/${ctx.orgId}/skills/${skillId}/files?${query.toString()}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("import")
      .description(getAgentCliCapabilityById("skill.import").description)
      .option("-O, --org-id <id>", "Organization ID")
      .requiredOption("--source <source>", "Skill source (local path, URL, or repo ref)")
      .action(async (opts: SkillImportOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = organizationSkillImportSchema.parse({ source: opts.source });
          const result = await ctx.api.post<OrganizationSkillImportResult>(`/api/orgs/${ctx.orgId}/skills/import`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("scan-local")
      .description(getAgentCliCapabilityById("skill.scan-local").description)
      .option("-O, --org-id <id>", "Organization ID")
      .option("--roots <csv>", "Comma-separated local roots to scan")
      .action(async (opts: SkillScanLocalOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = organizationSkillLocalScanRequestSchema.parse({
            roots: parseCsv(opts.roots),
          });
          const result = await ctx.api.post<OrganizationSkillLocalScanResult>(
            `/api/orgs/${ctx.orgId}/skills/scan-local`,
            payload,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("scan-projects")
      .description(getAgentCliCapabilityById("skill.scan-projects").description)
      .option("-O, --org-id <id>", "Organization ID")
      .option("--project-ids <csv>", "Comma-separated project IDs")
      .option("--workspace-ids <csv>", "Comma-separated workspace IDs")
      .action(async (opts: SkillScanProjectsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = organizationSkillProjectScanRequestSchema.parse({
            projectIds: parseCsv(opts.projectIds),
            workspaceIds: parseCsv(opts.workspaceIds),
          });
          const result = await ctx.api.post<OrganizationSkillProjectScanResult>(
            `/api/orgs/${ctx.orgId}/skills/scan-projects`,
            payload,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const rows = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return rows.length > 0 ? rows : undefined;
}

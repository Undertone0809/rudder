import { Command } from "commander";
import {
  createAgentHireSchema,
  type Agent,
  type AgentDetail,
  type AgentSkillSnapshot,
  type Approval,
} from "@rudder/shared";
import {
  removeMaintainerOnlySkillSymlinks,
  resolveRudderSkillsDir,
} from "@rudder/agent-runtime-utils/server-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import {
  buildAgentCliCapabilitiesManifest,
  formatAgentCliCapabilitiesHumanReadable,
  getAgentCliCapabilityById,
  getAgentCliCapabilities,
} from "../../agent-v1-registry.js";

interface AgentListOptions extends BaseClientOptions {
  orgId?: string;
}

interface AgentInboxItem {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  updatedAt: string;
  activeRun: unknown;
}

interface AgentLocalCliOptions extends BaseClientOptions {
  orgId?: string;
  keyName?: string;
  installSkills?: boolean;
}

interface AgentCapabilitiesOptions extends BaseClientOptions {
  contract?: string;
}

interface AgentHireOptions extends BaseClientOptions {
  orgId?: string;
  payload: string;
}

interface AgentSkillSyncOptions extends BaseClientOptions {
  desiredSkills: string;
}

interface AgentConfigurationRow {
  id: string;
  orgId: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  reportsTo: string | null;
  agentRuntimeType: string;
  agentRuntimeConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown> | null;
  updatedAt: string;
}

interface AgentHireResult {
  agent: Agent;
  approval: Approval | null;
}

interface CreatedAgentKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

interface SkillsInstallSummary {
  tool: "codex" | "claude";
  target: string;
  linked: string[];
  removed: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function codexSkillsHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".codex");
  return path.join(base, "skills");
}

function claudeSkillsHome(): string {
  const fromEnv = process.env.CLAUDE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".claude");
  return path.join(base, "skills");
}

async function installSkillsForTarget(
  sourceSkillsDir: string,
  targetSkillsDir: string,
  tool: "codex" | "claude",
): Promise<SkillsInstallSummary> {
  const summary: SkillsInstallSummary = {
    tool,
    target: targetSkillsDir,
    linked: [],
    removed: [],
    skipped: [],
    failed: [],
  };

  await fs.mkdir(targetSkillsDir, { recursive: true });
  const entries = await fs.readdir(sourceSkillsDir, { withFileTypes: true });
  summary.removed = await removeMaintainerOnlySkillSymlinks(
    targetSkillsDir,
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceSkillsDir, entry.name);
    const target = path.join(targetSkillsDir, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) {
      if (existing.isSymbolicLink()) {
        let linkedPath: string | null = null;
        try {
          linkedPath = await fs.readlink(target);
        } catch (err) {
          await fs.unlink(target);
          try {
            await fs.symlink(source, target);
            summary.linked.push(entry.name);
            continue;
          } catch (linkErr) {
            summary.failed.push({
              name: entry.name,
              error:
                err instanceof Error && linkErr instanceof Error
                  ? `${err.message}; then ${linkErr.message}`
                  : err instanceof Error
                    ? err.message
                    : `Failed to recover broken symlink: ${String(err)}`,
            });
            continue;
          }
        }

        const resolvedLinkedPath = path.isAbsolute(linkedPath)
          ? linkedPath
          : path.resolve(path.dirname(target), linkedPath);
        const linkedTargetExists = await fs
          .stat(resolvedLinkedPath)
          .then(() => true)
          .catch(() => false);

        if (!linkedTargetExists) {
          await fs.unlink(target);
        } else {
          summary.skipped.push(entry.name);
          continue;
        }
      } else {
        summary.skipped.push(entry.name);
        continue;
      }
    }

    try {
      await fs.symlink(source, target);
      summary.linked.push(entry.name);
    } catch (err) {
      summary.failed.push({
        name: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

function buildAgentEnvExports(input: {
  apiBase: string;
  orgId: string;
  agentId: string;
  apiKey: string;
}): string {
  const escaped = (value: string) => value.replace(/'/g, "'\"'\"'");
  return [
    `export RUDDER_API_URL='${escaped(input.apiBase)}'`,
    `export RUDDER_ORG_ID='${escaped(input.orgId)}'`,
    `export RUDDER_AGENT_ID='${escaped(input.agentId)}'`,
    `export RUDDER_API_KEY='${escaped(input.apiKey)}'`,
  ].join("\n");
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent operations");
  const config = agent.command("config").description("Agent configuration discovery and redacted snapshots");

  addCommonClientOptions(
    agent
      .command("me")
      .description(getAgentCliCapabilityById("agent.me").description)
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<AgentDetail>("/api/agents/me");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("inbox")
      .description(getAgentCliCapabilityById("agent.inbox").description)
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<AgentInboxItem[]>("/api/agents/me/inbox-lite")) ?? [];

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
                identifier: row.identifier,
                id: row.id,
                status: row.status,
                priority: row.priority,
                title: row.title,
                projectId: row.projectId,
                goalId: row.goalId,
                parentId: row.parentId,
                updatedAt: row.updatedAt,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("capabilities")
      .description(getAgentCliCapabilityById("agent.capabilities").description)
      .option("--contract <name>", "Capability subset to show (agent-v1 or all)", "agent-v1")
      .action(async (opts: AgentCapabilitiesOptions) => {
        try {
          const contract = opts.contract === "all" ? "all" : "agent-v1";
          const capabilities = getAgentCliCapabilities().filter((entry) =>
            contract === "all" ? true : entry.contract === contract);

          if (opts.json) {
            printOutput(buildAgentCliCapabilitiesManifest(contract), { json: true });
            return;
          }

          console.log(formatAgentCliCapabilitiesHumanReadable(capabilities));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("list")
      .description(getAgentCliCapabilityById("agent.list").description)
      .option("-O, --org-id <id>", "Organization ID")
      .action(async (opts: AgentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Agent[]>(`/api/orgs/${ctx.orgId}/agents`)) ?? [];

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
                name: row.name,
                role: row.role,
                status: row.status,
                reportsTo: row.reportsTo,
                budgetMonthlyCents: row.budgetMonthlyCents,
                spentMonthlyCents: row.spentMonthlyCents,
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
    config
      .command("index")
      .description(getAgentCliCapabilityById("agent.config.index").description)
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const doc = await ctx.api.get<string>("/llms/agent-configuration.txt");
          printOutput(doc ?? "", { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    config
      .command("doc")
      .description(getAgentCliCapabilityById("agent.config.doc").description)
      .argument("<agentRuntimeType>", "Agent runtime type")
      .action(async (agentRuntimeType: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const doc = await ctx.api.get<string>(
            `/llms/agent-configuration/${encodeURIComponent(agentRuntimeType)}.txt`,
          );
          printOutput(doc ?? "", { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    config
      .command("list")
      .description(getAgentCliCapabilityById("agent.config.list").description)
      .option("-O, --org-id <id>", "Organization ID")
      .action(async (opts: AgentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows =
            (await ctx.api.get<AgentConfigurationRow[]>(`/api/orgs/${ctx.orgId}/agent-configurations`)) ?? [];

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
                name: row.name,
                role: row.role,
                status: row.status,
                agentRuntimeType: row.agentRuntimeType,
                reportsTo: row.reportsTo,
                updatedAt: row.updatedAt,
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
    config
      .command("get")
      .description(getAgentCliCapabilityById("agent.config.get").description)
      .argument("<agentId>", "Agent ID or shortname/url-key")
      .option("-O, --org-id <id>", "Organization ID")
      .action(async (agentId: string, opts: AgentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = new URLSearchParams();
          if (ctx.orgId) query.set("orgId", ctx.orgId);
          const row = await ctx.api.get<AgentConfigurationRow>(
            `/api/agents/${encodeURIComponent(agentId)}/configuration${query.size > 0 ? `?${query.toString()}` : ""}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("icons")
      .description(getAgentCliCapabilityById("agent.icons").description)
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const doc = await ctx.api.get<string>("/llms/agent-icons.txt");
          printOutput(doc ?? "", { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const skills = agent.command("skills").description("Agent skill selection operations");

  addCommonClientOptions(
    skills
      .command("sync")
      .description(getAgentCliCapabilityById("agent.skills.sync").description)
      .argument("<agentId>", "Agent ID")
      .requiredOption(
        "--desired-skills <csv>",
        "Comma-separated desired skill refs (for example rudder/rudder)",
      )
      .action(async (agentId: string, opts: AgentSkillSyncOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const snapshot = await ctx.api.post<AgentSkillSnapshot>(`/api/agents/${agentId}/skills/sync`, {
            desiredSkills: parseCsv(opts.desiredSkills),
          });
          printOutput(snapshot, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("get")
      .description(getAgentCliCapabilityById("agent.get").description)
      .argument("<agentId>", "Agent ID or shortname/url-key")
      .option("-O, --org-id <id>", "Organization ID")
      .action(async (agentId: string, opts: AgentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = new URLSearchParams();
          if (ctx.orgId) query.set("orgId", ctx.orgId);
          const row = await ctx.api.get<Agent>(
            `/api/agents/${encodeURIComponent(agentId)}${query.size > 0 ? `?${query.toString()}` : ""}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("hire")
      .description(getAgentCliCapabilityById("agent.hire").description)
      .option("-O, --org-id <id>", "Organization ID")
      .requiredOption("--payload <json>", "Hire payload as JSON object")
      .action(async (opts: AgentHireOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payloadJson = parseJsonObject(opts.payload, "payload");
          const payload = createAgentHireSchema.parse(payloadJson);
          const created = await ctx.api.post<AgentHireResult>(`/api/orgs/${ctx.orgId}/agent-hires`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("local-cli")
      .description(
        "Create an agent API key, optionally install local Rudder skills for direct Codex/Claude CLI use, and print shell exports",
      )
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .option("-O, --org-id <id>", "Organization ID")
      .option("--key-name <name>", "API key label", "local-cli")
      .option(
        "--no-install-skills",
        "Skip the optional local Codex/Claude skill installation step",
      )
      .action(async (agentRef: string, opts: AgentLocalCliOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams({ orgId: ctx.orgId ?? "" });
          const agentRow = await ctx.api.get<Agent>(
            `/api/agents/${encodeURIComponent(agentRef)}?${query.toString()}`,
          );
          if (!agentRow) {
            throw new Error(`Agent not found: ${agentRef}`);
          }

          const now = new Date().toISOString().replaceAll(":", "-");
          const keyName = opts.keyName?.trim() ? opts.keyName.trim() : `local-cli-${now}`;
          const key = await ctx.api.post<CreatedAgentKey>(`/api/agents/${agentRow.id}/keys`, { name: keyName });
          if (!key) {
            throw new Error("Failed to create API key");
          }

          const installSummaries: SkillsInstallSummary[] = [];
          if (opts.installSkills !== false) {
            const skillsDir = await resolveRudderSkillsDir(__moduleDir, [path.resolve(process.cwd(), "skills")]);
            if (!skillsDir) {
              throw new Error(
                "Could not locate local Rudder skills directory. Expected ./skills in the repo checkout.",
              );
            }

            installSummaries.push(
              await installSkillsForTarget(skillsDir, codexSkillsHome(), "codex"),
              await installSkillsForTarget(skillsDir, claudeSkillsHome(), "claude"),
            );
          }

          const exportsText = buildAgentEnvExports({
            apiBase: ctx.api.apiBase,
            orgId: agentRow.orgId,
            agentId: agentRow.id,
            apiKey: key.token,
          });

          if (ctx.json) {
            printOutput(
              {
                agent: {
                  id: agentRow.id,
                  name: agentRow.name,
                  urlKey: agentRow.urlKey,
                  orgId: agentRow.orgId,
                },
                key: {
                  id: key.id,
                  name: key.name,
                  createdAt: key.createdAt,
                  token: key.token,
                },
                skills: installSummaries,
                exports: exportsText,
              },
              { json: true },
            );
            return;
          }

          console.log(`Agent: ${agentRow.name} (${agentRow.id})`);
          console.log(`API key created: ${key.name} (${key.id})`);
          if (installSummaries.length > 0) {
            for (const summary of installSummaries) {
              console.log(
                `${summary.tool}: linked=${summary.linked.length} removed=${summary.removed.length} skipped=${summary.skipped.length} failed=${summary.failed.length} target=${summary.target}`,
              );
              for (const failed of summary.failed) {
                console.log(`  failed ${failed.name}: ${failed.error}`);
              }
            }
          }
          console.log("");
          console.log("# Run this in your shell before launching codex/claude:");
          console.log(exportsText);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${name} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid ${name} JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

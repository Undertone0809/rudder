import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntimeSkillContext,
  AgentRuntimeSkillSnapshot,
} from "@rudderhq/agent-runtime-utils";
import {
  buildPersistentSkillSnapshot,
  readInstalledSkillTargets,
  readRudderRuntimeSkillEntries,
  resolveRudderDesiredSkillNames,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { realizeManagedCodexSkillEntries, resolveManagedCodexHomeDir } from "./codex-home.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildCodexSkillSnapshot(
  orgId: string,
  agentId: string,
  config: Record<string, unknown>,
): Promise<AgentRuntimeSkillSnapshot> {
  const availableEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveRudderDesiredSkillNames(config, availableEntries);
  const envConfig =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const stringEnv = Object.fromEntries(
    Object.entries(envConfig).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const skillsHome = path.join(
    configuredCodexHome ?? resolveManagedCodexHomeDir({ ...process.env, ...stringEnv }, orgId, agentId),
    "skills",
  );
  const installed = await readInstalledSkillTargets(skillsHome);
  installed.delete(".system");
  installed.delete("skills.json");
  return buildPersistentSkillSnapshot({
    agentRuntimeType: "codex_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "managed CODEX_HOME/skills",
    installedDetail: "Enabled for this agent in Rudder and materialized into the managed Codex skills home.",
    missingDetail: "Configured but not currently linked into the managed Codex skills home.",
    externalConflictDetail: "Skill name is occupied by a non-Rudder entry inside the managed Codex skills home.",
    externalDetail: "Installed outside Rudder management.",
  });
}

export async function listCodexSkills(ctx: AgentRuntimeSkillContext): Promise<AgentRuntimeSkillSnapshot> {
  return buildCodexSkillSnapshot(ctx.orgId, ctx.agentId, ctx.config);
}

export async function syncCodexSkills(
  ctx: AgentRuntimeSkillContext,
  desiredSkills: string[],
): Promise<AgentRuntimeSkillSnapshot> {
  const availableEntries = await readRudderRuntimeSkillEntries(ctx.config, __moduleDir);
  const envConfig =
    typeof ctx.config.env === "object" && ctx.config.env !== null && !Array.isArray(ctx.config.env)
      ? (ctx.config.env as Record<string, unknown>)
      : {};
  const stringEnv = Object.fromEntries(
    Object.entries(envConfig).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const sourceEnv = {
    ...process.env,
    ...stringEnv,
  };
  await realizeManagedCodexSkillEntries(
    sourceEnv,
    configuredCodexHome ?? resolveManagedCodexHomeDir(sourceEnv, ctx.orgId, ctx.agentId),
    availableEntries
      .filter((entry) => desiredSkills.includes(entry.key))
      .map((entry) => entry.source),
    async () => {},
  ).catch(() => {});
  return buildCodexSkillSnapshot(ctx.orgId, ctx.agentId, ctx.config);
}

export function resolveCodexDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveRudderDesiredSkillNames(config, availableEntries);
}

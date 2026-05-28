import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntimeSkillContext,
  AgentRuntimeSkillSnapshot,
} from "@rudderhq/agent-runtime-utils";
import {
  buildPersistentSkillSnapshot,
  ensureRudderRuntimeSkillSymlinks,
  readRudderRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveRudderDesiredSkillNames,
} from "@rudderhq/agent-runtime-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUDDER_INSTANCE_ID = "default";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveStringEnv(config: Record<string, unknown>): NodeJS.ProcessEnv {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  return {
    ...process.env,
    ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

function resolveCursorSkillsHome(ctx: Pick<AgentRuntimeSkillContext, "orgId" | "agentId" | "config">) {
  const env = resolveStringEnv(ctx.config);
  const rudderHome = asString(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = asString(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.join(
    rudderHome,
    "instances",
    instanceId,
    "organizations",
    ctx.orgId,
    "cursor-home",
    "agents",
    ctx.agentId,
    ".cursor",
    "skills",
  );
}

async function buildCursorSkillSnapshot(ctx: AgentRuntimeSkillContext): Promise<AgentRuntimeSkillSnapshot> {
  const config = ctx.config;
  const availableEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveRudderDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveCursorSkillsHome(ctx);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    agentRuntimeType: "cursor",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "managed Cursor skills home",
    missingDetail: "Configured but not currently linked into the Cursor skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Rudder management.",
  });
}

export async function listCursorSkills(ctx: AgentRuntimeSkillContext): Promise<AgentRuntimeSkillSnapshot> {
  return buildCursorSkillSnapshot(ctx);
}

export async function syncCursorSkills(
  ctx: AgentRuntimeSkillContext,
  desiredSkills: string[],
): Promise<AgentRuntimeSkillSnapshot> {
  const availableEntries = await readRudderRuntimeSkillEntries(ctx.config, __moduleDir);
  const skillsHome = resolveCursorSkillsHome(ctx);
  await ensureRudderRuntimeSkillSymlinks({
    onLog: async () => {},
    runtimeLabel: "Cursor",
    skillsHome,
    availableEntries,
    desiredSkillKeys: desiredSkills,
  });

  return buildCursorSkillSnapshot(ctx);
}

export function resolveCursorDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveRudderDesiredSkillNames(config, availableEntries);
}

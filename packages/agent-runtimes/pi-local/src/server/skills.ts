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

function resolvePiSkillsHome(ctx: Pick<AgentRuntimeSkillContext, "orgId" | "agentId" | "config">) {
  const env = resolveStringEnv(ctx.config);
  const rudderHome = asString(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = asString(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.join(
    rudderHome,
    "instances",
    instanceId,
    "organizations",
    ctx.orgId,
    "pi-home",
    "agents",
    ctx.agentId,
    ".pi",
    "agent",
    "skills",
  );
}

async function buildPiSkillSnapshot(ctx: AgentRuntimeSkillContext): Promise<AgentRuntimeSkillSnapshot> {
  const config = ctx.config;
  const availableEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveRudderDesiredSkillNames(config, availableEntries);
  const skillsHome = resolvePiSkillsHome(ctx);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    agentRuntimeType: "pi_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "managed Pi skills home",
    missingDetail: "Configured but not currently linked into the Pi skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Rudder management.",
  });
}

export async function listPiSkills(ctx: AgentRuntimeSkillContext): Promise<AgentRuntimeSkillSnapshot> {
  return buildPiSkillSnapshot(ctx);
}

export async function syncPiSkills(
  ctx: AgentRuntimeSkillContext,
  desiredSkills: string[],
): Promise<AgentRuntimeSkillSnapshot> {
  const availableEntries = await readRudderRuntimeSkillEntries(ctx.config, __moduleDir);
  const skillsHome = resolvePiSkillsHome(ctx);
  await ensureRudderRuntimeSkillSymlinks({
    onLog: async () => {},
    runtimeLabel: "Pi",
    skillsHome,
    availableEntries,
    desiredSkillKeys: desiredSkills,
  });

  return buildPiSkillSnapshot(ctx);
}

export function resolvePiDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveRudderDesiredSkillNames(config, availableEntries);
}

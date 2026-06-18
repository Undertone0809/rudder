import {
  resolveOrganizationStorageKey,
  type AgentRuntimeSkillContext,
  type AgentRuntimeSkillSnapshot,
} from "@rudderhq/agent-runtime-utils";
import {
  buildPersistentSkillSnapshot,
  ensureRudderSkillSymlink,
  readInstalledSkillTargets,
  readRudderRuntimeSkillEntries,
  resolveRudderDesiredSkillNames,
} from "@rudderhq/agent-runtime-utils/server-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUDDER_INSTANCE_ID = "default";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveManagedPiHomeDir(config: Record<string, unknown>, orgId: string) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const rudderHome = asString(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = asString(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(
    rudderHome,
    "instances",
    instanceId,
    "organizations",
    resolveOrganizationStorageKey(orgId),
    "pi-home",
  );
}

function withManagedPiAgentDir(ctx: AgentRuntimeSkillContext): Record<string, unknown> {
  const env =
    typeof ctx.config.env === "object" && ctx.config.env !== null && !Array.isArray(ctx.config.env)
      ? (ctx.config.env as Record<string, unknown>)
      : {};
  return {
    ...ctx.config,
    env: {
      ...env,
      PI_CODING_AGENT_DIR: path.join(resolveManagedPiHomeDir(ctx.config, ctx.orgId), ".pi", "agent"),
    },
  };
}

function resolvePiSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredAgentDir = asString(env.PI_CODING_AGENT_DIR);
  if (configuredAgentDir) return path.join(path.resolve(configuredAgentDir), "skills");
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".pi", "agent", "skills");
}

async function buildPiSkillSnapshot(ctx: AgentRuntimeSkillContext): Promise<AgentRuntimeSkillSnapshot> {
  const config = withManagedPiAgentDir(ctx);
  const availableEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveRudderDesiredSkillNames(config, availableEntries);
  const skillsHome = resolvePiSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    agentRuntimeType: "pi_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.pi/agent/skills",
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
  const managedConfig = withManagedPiAgentDir(ctx);
  const availableEntries = await readRudderRuntimeSkillEntries(managedConfig, __moduleDir);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolvePiSkillsHome(managedConfig);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensureRudderSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildPiSkillSnapshot(ctx);
}

export function resolvePiDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveRudderDesiredSkillNames(config, availableEntries);
}

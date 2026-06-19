import type {
  AgentRuntimeSkillContext,
  AgentRuntimeSkillSnapshot,
} from "@rudderhq/agent-runtime-utils";
import { resolveOrganizationStorageKey } from "@rudderhq/agent-runtime-utils";
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

export function resolveManagedOpenCodeHomeDir(config: Record<string, unknown>, orgId: string) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const rudderHome = asString(env.RUDDER_HOME) ?? process.env.RUDDER_HOME ?? path.join(os.homedir(), ".rudder");
  const instanceId = asString(env.RUDDER_INSTANCE_ID) ?? process.env.RUDDER_INSTANCE_ID ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(rudderHome, "instances", instanceId, "organizations", resolveOrganizationStorageKey(orgId), "opencode-home");
}

export function resolveOpenCodeSkillsHome(config: Record<string, unknown>, orgId: string) {
  return path.join(resolveManagedOpenCodeHomeDir(config, orgId), ".claude", "skills");
}

async function buildOpenCodeSkillSnapshot(config: Record<string, unknown>, orgId: string): Promise<AgentRuntimeSkillSnapshot> {
  const availableEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveRudderDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveOpenCodeSkillsHome(config, orgId);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    agentRuntimeType: "opencode_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "managed OpenCode skills sidecar",
    installedDetail: "Enabled for this agent in Rudder and materialized into the managed OpenCode skills sidecar.",
    missingDetail: "Configured but not currently linked into the managed OpenCode skills sidecar.",
    externalConflictDetail: "Skill name is occupied by a non-Rudder entry inside the managed OpenCode skills sidecar.",
    externalDetail: "Installed outside Rudder management in the OpenCode sidecar.",
  });
}

export async function listOpenCodeSkills(ctx: AgentRuntimeSkillContext): Promise<AgentRuntimeSkillSnapshot> {
  return buildOpenCodeSkillSnapshot(ctx.config, ctx.orgId);
}

export async function syncOpenCodeSkills(
  ctx: AgentRuntimeSkillContext,
  desiredSkills: string[],
): Promise<AgentRuntimeSkillSnapshot> {
  const availableEntries = await readRudderRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveOpenCodeSkillsHome(ctx.config, ctx.orgId);
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

  return buildOpenCodeSkillSnapshot(ctx.config, ctx.orgId);
}

export function resolveOpenCodeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveRudderDesiredSkillNames(config, availableEntries);
}

import type {
  AgentRuntimeSkillContext,
  AgentRuntimeSkillEntry,
  AgentRuntimeSkillSnapshot,
} from "@rudderhq/agent-runtime-utils";
import {
  readRudderRuntimeSkillEntries,
  resolveRudderDesiredSkillNames,
  writeRudderSkillSyncPreference,
} from "@rudderhq/agent-runtime-utils/server-utils";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildHermesGatewaySkillSnapshot(
  config: Record<string, unknown>,
): Promise<AgentRuntimeSkillSnapshot> {
  const availableEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolveRudderDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const entries: AgentRuntimeSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    description: entry.description ?? null,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: "organization_managed",
    locationLabel: "Per-run Hermes prompt",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Will be injected into the next Hermes Run without modifying the Hermes skill home."
      : null,
  }));
  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is unavailable and the next Hermes Run will fail closed.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "Unavailable",
      locationLabel: "Per-run Hermes prompt",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Rudder cannot read this skill from its managed runtime projection.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));
  return {
    agentRuntimeType: "hermes_gateway",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listHermesGatewaySkills(
  ctx: AgentRuntimeSkillContext,
): Promise<AgentRuntimeSkillSnapshot> {
  return buildHermesGatewaySkillSnapshot(ctx.config);
}

export async function syncHermesGatewaySkills(
  ctx: AgentRuntimeSkillContext,
  desiredSkills: string[],
): Promise<AgentRuntimeSkillSnapshot> {
  return buildHermesGatewaySkillSnapshot(
    writeRudderSkillSyncPreference(ctx.config, desiredSkills),
  );
}

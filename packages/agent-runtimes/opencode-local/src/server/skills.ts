import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntimeSkillContext,
  AgentRuntimeSkillEntry,
  AgentRuntimeSkillSnapshot,
} from "@rudder/agent-runtime-utils";
import {
  readRudderRuntimeSkillEntries,
  readInstalledSkillTargets,
  readSkillMetadataFromPath,
  resolveRudderDesiredSkillNames,
} from "@rudder/agent-runtime-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveOpenCodeSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".claude", "skills");
}

async function buildOpenCodeSkillSnapshot(config: Record<string, unknown>): Promise<AgentRuntimeSkillSnapshot> {
  const availableEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const availableRuntimeNames = new Set(availableEntries.map((entry) => entry.runtimeName));
  const desiredSkills = resolveRudderDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveOpenCodeSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  const entries: AgentRuntimeSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    description: entry.description ?? null,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: "organization_managed",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Will be mounted into the Rudder-managed OpenCode skill directory on the next run."
      : null,
  }));
  const warnings: string[] = [];
  const externalInstalled = new Map(
    Array.from(installed.entries()).filter(([name]) => !availableRuntimeNames.has(name)),
  );

  for (const [name, installedEntry] of externalInstalled.entries()) {
    const metadata = await readSkillMetadataFromPath(installedEntry.targetPath ?? path.join(skillsHome, name));
    const desired = desiredSet.has(name);
    entries.push({
      key: name,
      runtimeName: metadata.name ?? name,
      description: metadata.description,
      desired,
      managed: false,
      state: desired ? "configured" : "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: "~/.claude/skills",
      readOnly: false,
      sourcePath: installedEntry.targetPath ?? path.join(skillsHome, name),
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: desired
        ? "Enabled for this agent. Rudder will mount this user-installed OpenCode skill on the next run."
        : "Detected outside Rudder management in the user Claude-compatible skills home.",
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    if (externalInstalled.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Rudder skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Rudder cannot find this skill in the local runtime skills directory.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    agentRuntimeType: "opencode_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listOpenCodeSkills(ctx: AgentRuntimeSkillContext): Promise<AgentRuntimeSkillSnapshot> {
  return buildOpenCodeSkillSnapshot(ctx.config);
}

export async function syncOpenCodeSkills(
  ctx: AgentRuntimeSkillContext,
  _desiredSkills: string[],
): Promise<AgentRuntimeSkillSnapshot> {
  return buildOpenCodeSkillSnapshot(ctx.config);
}

export function resolveOpenCodeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveRudderDesiredSkillNames(config, availableEntries);
}

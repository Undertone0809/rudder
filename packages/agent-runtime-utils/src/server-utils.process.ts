import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentRuntimeSkillEntry,
  AgentRuntimeSkillSnapshot,
} from "./types.js";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
}

export interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
}

export interface SpawnTarget {
  command: string;
  args: string[];
}

export type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

export const runningProcesses = new Map<string, RunningProcess>();

export function isChildProcessAlive(child: ChildProcessWithEvents): boolean {
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) return false;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : null;
    return code === "EPERM";
  }
}
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;
export const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;
export const RUDDER_SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../server/resources/bundled-skills",
  "../../skills",
  "../../../../../server/resources/bundled-skills",
];
export const DEFAULT_LOCAL_CLI_CREDENTIAL_HOME_ENTRIES = [
  ".aws",
  ".azure",
  ".config/gh",
  ".config/gcloud",
  ".config/op",
  ".config/vercel",
  ".config/configstore",
  ".docker",
  ".fly",
  ".git-credentials",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".ssh",
  ".vercel",
  "Library/Application Support/gh",
  "Library/Application Support/com.heroku.cli",
] as const;
export type LocalCliCredentialShimCommand = {
  command: string;
  authCheckArgs?: readonly string[];
  credentialEntries?: readonly string[];
};

export const DEFAULT_LOCAL_CLI_OPERATOR_HOME_SHIM_COMMANDS = [
  {
    command: "gh",
    authCheckArgs: ["auth", "status"],
    credentialEntries: [".config/gh", "Library/Application Support/gh"],
  },
  {
    command: "vercel",
    authCheckArgs: ["whoami"],
    credentialEntries: [".config/vercel", ".vercel", ".config/configstore"],
  },
] as const satisfies readonly LocalCliCredentialShimCommand[];

export interface RudderSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  name: string | null;
  description: string | null;
}

export interface InstalledSkillTarget {
  targetPath: string | null;
  kind: "symlink" | "directory" | "file";
}

export interface PersistentSkillSnapshotOptions {
  agentRuntimeType: string;
  availableEntries: RudderSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  skillsHome: string;
  locationLabel?: string | null;
  installedDetail?: string | null;
  missingDetail: string;
  externalConflictDetail: string;
  externalDetail: string;
  warnings?: string[];
}

export function normalizePathSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

export function isMaintainerOnlySkillTarget(candidate: string): boolean {
  const normalized = normalizePathSlashes(candidate);
  return (
    normalized.includes("/server/resources/bundled-skills/")
    || normalized.includes("/.agents/skills/")
  );
}

export function skillLocationLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildManagedSkillOrigin(): Pick<
  AgentRuntimeSkillEntry,
  "origin" | "originLabel" | "readOnly"
> {
  return {
    origin: "organization_managed",
    readOnly: false,
  };
}

export function compactSkillText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const compacted = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return compacted.length > 0 ? compacted : null;
}

export function parseSkillFrontmatterMetadata(markdown: string): {
  name: string | null;
  description: string | null;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return { name: null, description: null };
  }

  const yaml = match[1];
  const nameMatch = yaml.match(/^name:\s*["']?(.*?)["']?\s*$/m);
  const descriptionMatch = yaml.match(
    /^description:\s*(?:>\s*\n((?:\s{2,}[^\n]*\n?)+)|[|]\s*\n((?:\s{2,}[^\n]*\n?)+)|["']?(.*?)["']?\s*$)/m,
  );

  return {
    name: compactSkillText(nameMatch?.[1] ?? null),
    description: compactSkillText(descriptionMatch?.[1] ?? descriptionMatch?.[2] ?? descriptionMatch?.[3] ?? null),
  };
}

export async function readSkillMetadataFromDirectory(skillDir: string): Promise<{
  name: string | null;
  description: string | null;
}> {
  const skillFile = path.join(skillDir, "SKILL.md");
  try {
    const markdown = await fs.readFile(skillFile, "utf8");
    return parseSkillFrontmatterMetadata(markdown);
  } catch {
    return { name: null, description: null };
  }
}

export async function readSkillMetadataFromPath(candidatePath: string | null | undefined): Promise<{
  name: string | null;
  description: string | null;
}> {
  if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
    return { name: null, description: null };
  }
  const resolvedPath = path.resolve(candidatePath);
  const skillDir = path.basename(resolvedPath).toLowerCase() === "skill.md"
    ? path.dirname(resolvedPath)
    : resolvedPath;
  return readSkillMetadataFromDirectory(skillDir);
}

export function resolveInstalledEntryTarget(
  skillsHome: string,
  entryName: string,
  dirent: Dirent,
  linkedPath: string | null,
): InstalledSkillTarget {
  const fullPath = path.join(skillsHome, entryName);
  if (dirent.isSymbolicLink()) {
    return {
      targetPath: linkedPath ? path.resolve(path.dirname(fullPath), linkedPath) : null,
      kind: "symlink",
    };
  }
  if (dirent.isDirectory()) {
    return { targetPath: fullPath, kind: "directory" };
  }
  return { targetPath: fullPath, kind: "file" };
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

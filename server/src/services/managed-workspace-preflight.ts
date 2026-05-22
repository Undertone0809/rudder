import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const WORKSPACE_PERMISSION_REPAIR_NEEDED_CODE = "workspace_permission_repair_needed";
export const MANAGED_WORKSPACE_CONFIGURATION_ERROR_CODE = "managed_workspace_configuration_error";

export type ManagedWorkspacePreflightPathKind =
  | "agent_home"
  | "instructions"
  | "memory"
  | "life"
  | "skills";

export interface ManagedWorkspacePreflightPath {
  kind: ManagedWorkspacePreflightPathKind;
  path: string;
}

export interface ManagedWorkspacePreflightInput {
  agentHome: string;
  instructionsDir: string;
  memoryDir: string;
  lifeDir: string;
  skillsDir: string;
}

export interface ManagedWorkspacePreflightFailure {
  kind: ManagedWorkspacePreflightPathKind;
  path: string;
  operation: "configure" | "mkdir" | "stat" | "write_probe";
  code: string | null;
  message: string;
}

export class WorkspacePermissionPreflightError extends Error {
  readonly errorCode = WORKSPACE_PERMISSION_REPAIR_NEEDED_CODE;
  readonly failure: ManagedWorkspacePreflightFailure;

  constructor(failure: ManagedWorkspacePreflightFailure) {
    super(formatWorkspacePermissionPreflightMessage(failure));
    this.name = "WorkspacePermissionPreflightError";
    this.failure = failure;
  }
}

export class ManagedWorkspaceConfigurationError extends Error {
  readonly errorCode = MANAGED_WORKSPACE_CONFIGURATION_ERROR_CODE;
  readonly failure: ManagedWorkspacePreflightFailure;

  constructor(failure: ManagedWorkspacePreflightFailure) {
    super(formatManagedWorkspaceConfigurationErrorMessage(failure));
    this.name = "ManagedWorkspaceConfigurationError";
    this.failure = failure;
  }
}

function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toFailure(
  entry: ManagedWorkspacePreflightPath,
  operation: ManagedWorkspacePreflightFailure["operation"],
  error: unknown,
): ManagedWorkspacePreflightFailure {
  return {
    kind: entry.kind,
    path: entry.path,
    operation,
    code: errorCode(error),
    message: errorMessage(error),
  };
}

export function formatWorkspacePermissionPreflightMessage(
  failure: ManagedWorkspacePreflightFailure,
): string {
  const codeSuffix = failure.code ? ` (${failure.code})` : "";
  return [
    `Rudder workspace permission repair needed: managed ${failure.kind} path is not writable: ${failure.path}${codeSuffix}.`,
    "Repair the Rudder workspace permissions or move RUDDER_HOME to a writable location before starting the run.",
  ].join(" ");
}

export function formatManagedWorkspaceConfigurationErrorMessage(
  failure: ManagedWorkspacePreflightFailure,
): string {
  return [
    `Rudder runtime configuration error: managed ${failure.kind} path is missing before workspace preflight.`,
    "This is a Rudder runtime bootstrap bug; rebuild the run context before starting the run.",
  ].join(" ");
}

export function workspacePreflightPaths(
  input: ManagedWorkspacePreflightInput,
): ManagedWorkspacePreflightPath[] {
  return [
    { kind: "agent_home", path: input.agentHome },
    { kind: "instructions", path: input.instructionsDir },
    { kind: "memory", path: input.memoryDir },
    { kind: "life", path: input.lifeDir },
    { kind: "skills", path: input.skillsDir },
  ];
}

function validatePreflightPath(entry: ManagedWorkspacePreflightPath): void {
  if (entry.path.trim().length > 0) return;
  throw new ManagedWorkspaceConfigurationError({
    kind: entry.kind,
    path: entry.path,
    operation: "configure",
    code: "MISSING_PATH",
    message: "Managed workspace path is missing.",
  });
}

async function ensureDirectory(entry: ManagedWorkspacePreflightPath): Promise<void> {
  try {
    await fs.mkdir(entry.path, { recursive: true });
  } catch (error) {
    throw new WorkspacePermissionPreflightError(toFailure(entry, "mkdir", error));
  }

  try {
    const stat = await fs.stat(entry.path);
    if (!stat.isDirectory()) {
      throw new Error("Path exists but is not a directory");
    }
  } catch (error) {
    throw new WorkspacePermissionPreflightError(toFailure(entry, "stat", error));
  }
}

async function probeWritableDirectory(entry: ManagedWorkspacePreflightPath): Promise<void> {
  const probePath = path.join(entry.path, `.rudder-write-probe-${process.pid}-${randomUUID()}`);
  try {
    await fs.writeFile(probePath, "ok", { flag: "wx" });
  } catch (error) {
    throw new WorkspacePermissionPreflightError(toFailure(entry, "write_probe", error));
  } finally {
    await fs.rm(probePath, { force: true }).catch(() => undefined);
  }
}

export async function preflightManagedAgentWorkspace(
  input: ManagedWorkspacePreflightInput,
): Promise<ManagedWorkspacePreflightPath[]> {
  const entries = workspacePreflightPaths(input);
  for (const entry of entries) {
    validatePreflightPath(entry);
    await ensureDirectory(entry);
    await probeWritableDirectory(entry);
  }
  return entries;
}

export function isWorkspacePermissionPreflightError(
  error: unknown,
): error is WorkspacePermissionPreflightError {
  return error instanceof WorkspacePermissionPreflightError;
}

export function isManagedWorkspaceConfigurationError(
  error: unknown,
): error is ManagedWorkspaceConfigurationError {
  return error instanceof ManagedWorkspaceConfigurationError;
}

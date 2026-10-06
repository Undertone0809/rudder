import os from "node:os";
import path from "node:path";
import { diagnoseFilesystemRun, findRunLog, loadFilesystemRunDetail } from "../loaders/filesystem.js";
import { diagnoseObservedRun, findObservedRunSummaryByPrefix, loadObservedRunDetail } from "../loaders/rudder.js";
import type { ObservedRunDetail, RunDiagnosisMode } from "../types.js";

export const apiBaseUrl = process.env.RUDDER_API_URL ?? "http://localhost:3100/api";

const instanceIdPattern = /^[a-zA-Z0-9_-]+$/;

function expandHomePrefix(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.resolve(homeDir, value.slice(2));
  return value;
}

export function resolveRunLogDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const homeDir = env.HOME?.trim() || os.homedir();
  const explicitRunLogDir = env.RUDDER_RUN_LOG_DIR?.trim();
  if (explicitRunLogDir) {
    return path.resolve(expandHomePrefix(explicitRunLogDir, homeDir));
  }

  const rudderHome = env.RUDDER_HOME?.trim() || path.join(homeDir, ".rudder");
  const instanceId = env.RUDDER_INSTANCE_ID?.trim() || "dev";
  if (!instanceIdPattern.test(instanceId)) {
    throw new Error(`Invalid RUDDER_INSTANCE_ID '${instanceId}'.`);
  }

  return path.resolve(expandHomePrefix(rudderHome, homeDir), "instances", instanceId, "data", "run-logs");
}

export const dataDir = resolveRunLogDataDir();

export async function loadObservedRunDetailForCli(runId: string): Promise<ObservedRunDetail> {
  const matched = await findObservedRunSummaryByPrefix(apiBaseUrl, runId).catch(() => null);
  if (matched) {
    return loadObservedRunDetail(apiBaseUrl, matched.id);
  }

  const filesystemMatch = findRunLog(dataDir, runId);
  if (!filesystemMatch) {
    throw new Error(`Run "${runId}" not found in API or filesystem.`);
  }

  return loadFilesystemRunDetail({ match: filesystemMatch });
}

export async function diagnoseRunForCli(runId: string, mode: RunDiagnosisMode) {
  const matched = await findObservedRunSummaryByPrefix(apiBaseUrl, runId).catch(() => null);
  if (matched) {
    return diagnoseObservedRun(apiBaseUrl, matched.id, mode);
  }

  const filesystemMatch = findRunLog(dataDir, runId);
  if (!filesystemMatch) {
    throw new Error(`Run "${runId}" not found in API or filesystem.`);
  }

  return diagnoseFilesystemRun({ match: filesystemMatch, mode });
}

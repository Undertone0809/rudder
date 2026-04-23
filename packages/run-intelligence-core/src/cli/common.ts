import path from "node:path";
import { diagnoseObservedRun, findObservedRunByPrefix, loadObservedRunDetail } from "../loaders/rudder.js";
import { diagnoseFilesystemRun, findRunLog, loadFilesystemRunDetail } from "../loaders/filesystem.js";
import type { ObservedRunDetail, RunDiagnosisMode } from "../types.js";

export const apiBaseUrl = process.env.RUDDER_API_URL ?? "http://localhost:3100/api";
export const dataDir = process.env.RUDDER_RUN_LOG_DIR ?? path.join(process.env.HOME ?? "", ".rudder/instances/dev/data/run-logs");

export async function loadObservedRunDetailForCli(runId: string): Promise<ObservedRunDetail> {
  const matched = await findObservedRunByPrefix(apiBaseUrl, runId).catch(() => null);
  if (matched) {
    return loadObservedRunDetail(apiBaseUrl, matched.run.id);
  }

  const filesystemMatch = findRunLog(dataDir, runId);
  if (!filesystemMatch) {
    throw new Error(`Run "${runId}" not found in API or filesystem.`);
  }

  return loadFilesystemRunDetail({ match: filesystemMatch });
}

export async function diagnoseRunForCli(runId: string, mode: RunDiagnosisMode) {
  const matched = await findObservedRunByPrefix(apiBaseUrl, runId).catch(() => null);
  if (matched) {
    return diagnoseObservedRun(apiBaseUrl, matched.run.id, mode);
  }

  const filesystemMatch = findRunLog(dataDir, runId);
  if (!filesystemMatch) {
    throw new Error(`Run "${runId}" not found in API or filesystem.`);
  }

  return diagnoseFilesystemRun({ match: filesystemMatch, mode });
}

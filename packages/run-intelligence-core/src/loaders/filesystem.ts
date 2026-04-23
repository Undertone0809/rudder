import fs from "node:fs";
import path from "node:path";
import type { HeartbeatRun } from "@rudder/shared";
import { diagnoseRun } from "../diagnosis.js";
import { observedRunFromFilesystem } from "./rudder.js";
import type { RunDiagnosis, RunDiagnosisMode } from "../types.js";

export interface FilesystemRunMatch {
  runId: string;
  logPath: string;
  logRef: string;
  orgId: string | null;
  agentId: string | null;
}

export function findRunLog(dataDir: string, runIdPrefix: string): FilesystemRunMatch | null {
  const prefix = runIdPrefix.toLowerCase();
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walk(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".ndjson")) {
        files.push(fullPath);
      }
    }
    return files;
  };

  for (const filePath of walk(dataDir)) {
    const basename = path.basename(filePath, ".ndjson").toLowerCase();
    if (basename !== prefix && !basename.startsWith(prefix)) continue;
    const rel = path.relative(dataDir, filePath);
    const segments = rel.split(path.sep);
    return {
      runId: path.basename(filePath, ".ndjson"),
      logPath: filePath,
      logRef: rel,
      orgId: segments[0] ?? null,
      agentId: segments[1] ?? null,
    };
  }

  return null;
}

export function loadRunLogContent(logPath: string): string {
  return fs.readFileSync(logPath, "utf8");
}

export function loadFilesystemRunDetail(input: {
  match: FilesystemRunMatch;
  agentRuntimeType?: string;
  agentName?: string | null;
}) {
  const logContent = loadRunLogContent(input.match.logPath);
  const now = new Date();
  const run: HeartbeatRun = {
    id: input.match.runId,
    orgId: input.match.orgId ?? "unknown",
    agentId: input.match.agentId ?? "unknown",
    invocationSource: "on_demand",
    triggerDetail: null,
    status: "running",
    startedAt: now,
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: "local_file",
    logRef: input.match.logRef,
    logBytes: Buffer.byteLength(logContent, "utf8"),
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: { agentRuntimeType: input.agentRuntimeType ?? "process" },
    createdAt: now,
    updatedAt: now,
  };
  return observedRunFromFilesystem({
    run,
    agentName: input.agentName ?? input.match.agentId,
    logContent,
    bundle: {
      agentRuntimeType: input.agentRuntimeType ?? "process",
      agentConfigRevisionId: null,
      agentConfigRevisionCreatedAt: null,
      agentConfigFingerprint: null,
      runtimeConfigFingerprint: null,
    },
  });
}

export function diagnoseFilesystemRun(input: {
  match: FilesystemRunMatch;
  agentRuntimeType?: string;
  agentName?: string | null;
  mode?: RunDiagnosisMode;
}): { detail: ReturnType<typeof observedRunFromFilesystem>; diagnosis: RunDiagnosis } {
  const detail = loadFilesystemRunDetail(input);
  const diagnosis = diagnoseRun(detail, input.mode ?? "auto");
  return { detail, diagnosis };
}

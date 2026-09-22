import type { AgentRuntimeSessionCodec } from "@rudderhq/agent-runtime-utils";

export * from "./app-server-client.js";
export { estimateCodexCostUsd, resolveCodexTokenPrice } from "./cost.js";
export { execute, getProviderReadinessFingerprint } from "./execute.js";
export {
  createCodexLocalProviderCapabilities,
  createCodexLocalProviderCapabilityResolver,
  resolveCodexLocalProviderCapabilities,
  runtimeProviderCapabilities,
} from "./native-capabilities.js";
export {
  forkCodexNativeThread,
  readCodexNativeTranscript,
  resumeCodexNativeThread,
} from "./app-server-native.js";
export type {
  CodexAppServerProfileTransport,
  CodexAppServerProfileTransportResolver,
  CodexCapabilityEvidence,
  CodexNativeCapabilityError,
  CodexNativeCapabilityStatus,
  CodexNativeForkRequest,
  CodexNativeForkResult,
  CodexNativeTranscriptReadRequest,
  CodexNativeTranscriptReadResult,
  CodexProviderBindingRef,
  CodexProviderSessionRef,
} from "./app-server-native.js";
export {
  isCodexProviderAuthFailure,
  isCodexTransportDisconnectError,
  isCodexUnknownSessionError,
  parseCodexJsonl
} from "./parse.js";
export {
  codexHomeDir, fetchCodexQuota,
  fetchCodexRpcQuota, fetchWithTimeout, getQuotaWindows, mapCodexRpcQuota, readCodexAuthInfo,
  readCodexToken, secondsToWindowLabel
} from "./quota.js";
export { listCodexSkills, syncCodexSkills } from "./skills.js";
export { testEnvironment } from "./test.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const CODEX_PROVIDER_SESSION_FIELDS = [
  "threadId",
  "rootSessionId",
  "forkedFromId",
  "model",
  "modelProvider",
  "ephemeral",
  "transport",
  "profileHostId",
  "profileId",
  "profileBindingId",
  "profileOrgId",
  "workspaceBindingId",
  "capabilityRevision",
] as const;

function readProviderSessionFields(record: Record<string, unknown>): Record<string, unknown> {
  const fields: Array<[string, string | boolean]> = [];
  for (const key of CODEX_PROVIDER_SESSION_FIELDS) {
    if (key === "ephemeral" && typeof record[key] === "boolean") {
      fields.push([key, record[key] as boolean]);
      continue;
    }
    const value = readNonEmptyString(record[key]);
    if (value) fields.push([key, value]);
  }
  return Object.fromEntries(fields);
}

function readCodexSessionId(record: Record<string, unknown>): string | null {
  return readNonEmptyString(record.sessionId)
    ?? readNonEmptyString(record.session_id)
    ?? readNonEmptyString(record.threadId);
}

export const sessionCodec: AgentRuntimeSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readCodexSessionId(record);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...readProviderSessionFields(record),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readCodexSessionId(params);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...readProviderSessionFields(params),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readCodexSessionId(params);
  },
};

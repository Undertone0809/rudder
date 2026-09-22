import type { AgentRuntimeSessionCodec } from "@rudderhq/agent-runtime-utils";

export { execute, runClaudeLogin } from "./execute.js";
export { runtimeProviderCapabilities } from "./native-capabilities.js";
export {
  createClaudeLocalProviderCapabilities,
  createClaudeLocalProviderCapabilityResolver,
  resolveClaudeLocalProviderCapabilities,
  parseClaudeSessionJsonl,
  resolveClaudeSessionFilePath,
} from "./native-capabilities.js";
export type {
  ClaudeCapabilityEvidence,
  ClaudeLocalProfileTransport,
  ClaudeLocalProfileTransportResolver,
  ClaudeNativeTranscriptReadRequest,
  ClaudeNativeTranscriptReadResult,
  ClaudeProviderBindingRef,
  ClaudeProviderSessionRef,
  ClaudeRuntimeProviderCapabilityAdapter,
} from "./native-capabilities.js";
export {
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError, parseClaudeStreamJson
} from "./parse.js";
export {
  captureClaudeCliUsageText, claudeConfigDir, fetchClaudeCliQuota, fetchClaudeQuota, fetchWithTimeout, getQuotaWindows, parseClaudeCliUsageText, readClaudeAuthStatus,
  readClaudeToken, toPercent
} from "./quota.js";
export { listClaudeSkills, syncClaudeSkills } from "./skills.js";
export { testEnvironment } from "./test.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const PROVIDER_SESSION_FIELDS = [
  "profileHostId",
  "profileId",
  "profileBindingId",
  "profileOrgId",
  "workspaceBindingId",
  "capabilityRevision",
  "transport",
  "claudeConfigDir",
  "sessionFilePath",
] as const;

function readProviderSessionFields(record: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    PROVIDER_SESSION_FIELDS.flatMap((key) => {
      const value = readNonEmptyString(record[key]);
      return value ? [[key, value]] : [];
    }),
  );
}

export const sessionCodec: AgentRuntimeSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
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
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
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
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};

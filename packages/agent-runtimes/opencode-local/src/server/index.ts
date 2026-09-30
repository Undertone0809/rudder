import type { AgentRuntimeSessionCodec } from "@rudderhq/agent-runtime-utils";
export {
  createOpenCodeLocalProviderCapabilities,
  createOpenCodeLocalProviderCapabilityResolver,
  resolveOpenCodeLocalProviderCapabilities,
  runtimeProviderCapabilities
} from "./native-capabilities.js";
export type {
  OpenCodeCapabilityEvidence,
  OpenCodeCapabilityStatus,
  OpenCodeLocalProfileTransport,
  OpenCodeLocalProfileTransportResolver,
  OpenCodeRuntimeProviderCapabilityAdapter
} from "./native-capabilities.js";
export {
  disposeOpenCodeNativeServersForTests,
  ensureManagedOpenCodeServer,
  executeOpenCodeNativeChat,
  forkOpenCodeNativeSession, OpenCodeNativeCapabilityError, readOpenCodeNativeTranscript
} from "./native-protocol.js";
export type {
  OpenCodeBinding,
  OpenCodeForkRequest,
  OpenCodeForkResult,
  OpenCodeSession,
  OpenCodeTranscriptRequest,
  OpenCodeTranscriptResult
} from "./native-protocol.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const PROVIDER_SESSION_FIELDS = [
  "profileBindingId",
  "profileOrgId",
  "hostId",
  "profileId",
  "openCodeProfileDataId",
  "capabilityRevision",
  "transport",
  "serverUrl",
  "serverCommand",
  "exportCommand",
  "directory",
  "providerVersion",
] as const;

const SAFE_PERSISTED_ENV_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "OPENCODE_CONFIG",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  "RUDDER_OPERATOR_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
]);

function readProviderSessionFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    PROVIDER_SESSION_FIELDS.flatMap((key) => {
      const value = readNonEmptyString(record[key]);
      return value ? [[key, value]] : [];
    }),
  );
}

function readProviderExportEnv(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([key, entry]) => SAFE_PERSISTED_ENV_KEYS.has(key)
    && typeof entry === "string"
    && entry.trim().length > 0)) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function readProviderSessionFieldsWithEnv(record: Record<string, unknown>): Record<string, unknown> | null {
  const hasExportEnv = Object.prototype.hasOwnProperty.call(record, "exportEnv");
  const exportEnv = hasExportEnv ? readProviderExportEnv(record.exportEnv) : null;
  if (hasExportEnv && !exportEnv) return null;
  return {
    ...readProviderSessionFields(record),
    ...(hasExportEnv ? { exportEnv } : {}),
  };
}

export const sessionCodec: AgentRuntimeSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.sessionID);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    const workspaceBindingId = readNonEmptyString(record.workspaceBindingId) ?? readNonEmptyString(record.workspace_binding_id);
    const providerFields = readProviderSessionFieldsWithEnv(record);
    if (!providerFields) return null;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(workspaceBindingId ? { workspaceBindingId } : {}),
      ...providerFields,
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    const workspaceBindingId = readNonEmptyString(params.workspaceBindingId) ?? readNonEmptyString(params.workspace_binding_id);
    const providerFields = readProviderSessionFieldsWithEnv(params);
    if (!providerFields) return null;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(workspaceBindingId ? { workspaceBindingId } : {}),
      ...providerFields,
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID)
    );
  },
};

export { execute, resolveOpenCodeProfileDataHome } from "./execute.js";
export {
  discoverOpenCodeModels,
  discoverOpenCodeModelsCached,
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  resetOpenCodeModelsCacheForTests,
  validateOpenCodeModelConfig
} from "./models.js";
export { isOpenCodeUnknownSessionError, parseOpenCodeJsonl } from "./parse.js";
export { listOpenCodeSkills, syncOpenCodeSkills } from "./skills.js";
export { testEnvironment } from "./test.js";

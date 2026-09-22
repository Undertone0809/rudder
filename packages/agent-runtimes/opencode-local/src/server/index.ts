import type { AgentRuntimeSessionCodec } from "@rudderhq/agent-runtime-utils";
export {
  createOpenCodeLocalProviderCapabilities,
  createOpenCodeLocalProviderCapabilityResolver,
  resolveOpenCodeLocalProviderCapabilities,
  runtimeProviderCapabilities,
} from "./native-capabilities.js";
export type {
  OpenCodeCapabilityEvidence,
  OpenCodeCapabilityStatus,
  OpenCodeLocalProfileTransport,
  OpenCodeLocalProfileTransportResolver,
  OpenCodeRuntimeProviderCapabilityAdapter,
} from "./native-capabilities.js";
export {
  disposeOpenCodeNativeServersForTests,
  ensureManagedOpenCodeServer,
  executeOpenCodeNativeChat,
  forkOpenCodeNativeSession,
  readOpenCodeNativeTranscript,
} from "./native-protocol.js";
export type {
  OpenCodeBinding,
  OpenCodeForkRequest,
  OpenCodeForkResult,
  OpenCodeSession,
  OpenCodeTranscriptRequest,
  OpenCodeTranscriptResult,
} from "./native-protocol.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const PROVIDER_SESSION_FIELDS = [
  "hostId",
  "profileId",
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
  const result = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => SAFE_PERSISTED_ENV_KEYS.has(entry[0]) && typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
  return result;
}

function readProviderSessionFieldsWithEnv(record: Record<string, unknown>): Record<string, unknown> {
  const exportEnv = readProviderExportEnv(record.exportEnv);
  return {
    ...readProviderSessionFields(record),
    ...(exportEnv ? { exportEnv } : {}),
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
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(workspaceBindingId ? { workspaceBindingId } : {}),
      ...readProviderSessionFieldsWithEnv(record),
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
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(workspaceBindingId ? { workspaceBindingId } : {}),
      ...readProviderSessionFieldsWithEnv(params),
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

export { execute } from "./execute.js";
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

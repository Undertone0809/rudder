import type { AgentRuntimeSessionCodec } from "@rudderhq/agent-runtime-utils";
export {
  createPiLocalProviderCapabilities,
  createPiLocalProviderCapabilityResolver,
  resolvePiLocalProviderCapabilities,
  runtimeProviderCapabilities
} from "./native-capabilities.js";
export type {
  PiCapabilityEvidence,
  PiCapabilityStatus,
  PiLocalProfileTransport,
  PiLocalProfileTransportResolver,
  PiRuntimeProviderCapabilityAdapter
} from "./native-capabilities.js";
export {
  createPiRpcControlHandle,
  executePiNativeChat,
  forkPiNativeSession, PI_NATIVE_TRANSPORT, readPiNativeTranscript
} from "./native-protocol.js";
export type {
  PiBinding,
  PiForkRequest,
  PiForkResult,
  PiSession, PiTranscriptRequest,
  PiTranscriptResult, PiWorkspaceIdentity
} from "./native-protocol.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const PROVIDER_SESSION_FIELDS = [
  "profileBindingId",
  "profileOrgId",
  "hostId",
  "profileId",
  "transport",
  "providerVersion",
  "capabilityRevision",
  "workspaceId",
  "repoUrl",
  "repoRef",
  "workspaceBindingId",
  "sessionFile",
  "sessionDir",
  "cwd",
  "command",
  "providerSessionId",
  "leafId",
  "previousLeafId",
] as const;

const SAFE_PERSISTED_ENV_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
]);

function readProviderSessionFields(record: Record<string, unknown>): Record<string, unknown> | null {
  const hasRpcEnv = Object.prototype.hasOwnProperty.call(record, "rpcEnv");
  const rpcEnvRecord = typeof record.rpcEnv === "object" && record.rpcEnv !== null && !Array.isArray(record.rpcEnv)
    ? record.rpcEnv as Record<string, unknown>
    : null;
  if (hasRpcEnv && !rpcEnvRecord) return null;
  const rpcEnvEntries = rpcEnvRecord ? Object.entries(rpcEnvRecord) : [];
  if (hasRpcEnv && !rpcEnvEntries.every(([key, entry]) => SAFE_PERSISTED_ENV_KEYS.has(key)
    && typeof entry === "string"
    && entry.trim().length > 0)) return null;
  const rpcEnv = hasRpcEnv ? Object.fromEntries(rpcEnvEntries) as Record<string, string> : null;
  const hasRpcArgs = Object.prototype.hasOwnProperty.call(record, "rpcArgs");
  if (hasRpcArgs && (!Array.isArray(record.rpcArgs) || !record.rpcArgs.every((value) => typeof value === "string"))) return null;
  return {
    ...Object.fromEntries(
      PROVIDER_SESSION_FIELDS.flatMap((key) => {
        const value = readNonEmptyString(record[key]);
        return value ? [[key, value]] : [];
      }),
    ),
    ...(hasRpcArgs ? { rpcArgs: [...record.rpcArgs as string[]] } : {}),
    ...(hasRpcEnv ? { rpcEnv } : {}),
  };
}

export const sessionCodec: AgentRuntimeSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const providerFields = readProviderSessionFields(record);
    if (!providerFields) return null;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...providerFields,
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const providerFields = readProviderSessionFields(params);
    if (!providerFields) return null;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...providerFields,
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session)
    );
  },
};

export { execute } from "./execute.js";
export {
  discoverPiModels,
  discoverPiModelsCached,
  ensurePiModelConfiguredAndAvailable, listPiModels, resetPiModelsCacheForTests
} from "./models.js";
export { isPiUnknownSessionError, parsePiJsonl } from "./parse.js";
export { listPiSkills, syncPiSkills } from "./skills.js";
export { testEnvironment } from "./test.js";

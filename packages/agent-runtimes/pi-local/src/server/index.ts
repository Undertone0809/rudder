import type { AgentRuntimeSessionCodec } from "@rudderhq/agent-runtime-utils";
export {
  createPiLocalProviderCapabilities,
  createPiLocalProviderCapabilityResolver,
  resolvePiLocalProviderCapabilities,
  runtimeProviderCapabilities,
} from "./native-capabilities.js";
export type {
  PiCapabilityEvidence,
  PiCapabilityStatus,
  PiLocalProfileTransport,
  PiLocalProfileTransportResolver,
  PiRuntimeProviderCapabilityAdapter,
} from "./native-capabilities.js";
export {
  createPiRpcControlHandle,
  executePiNativeChat,
  forkPiNativeSession,
  readPiNativeTranscript,
} from "./native-protocol.js";
export type {
  PiBinding,
  PiForkRequest,
  PiForkResult,
  PiSession,
  PiTranscriptRequest,
  PiTranscriptResult,
} from "./native-protocol.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const PROVIDER_SESSION_FIELDS = [
  "hostId",
  "profileId",
  "capabilityRevision",
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

function readProviderSessionFields(record: Record<string, unknown>): Record<string, unknown> {
  const rpcEnv = typeof record.rpcEnv === "object" && record.rpcEnv !== null && !Array.isArray(record.rpcEnv)
    ? Object.fromEntries(
      Object.entries(record.rpcEnv as Record<string, unknown>).filter(
        (entry): entry is [string, string] => SAFE_PERSISTED_ENV_KEYS.has(entry[0]) && typeof entry[1] === "string" && entry[1].trim().length > 0,
      ),
    )
    : null;
  return {
    ...Object.fromEntries(
      PROVIDER_SESSION_FIELDS.flatMap((key) => {
        const value = readNonEmptyString(record[key]);
        return value ? [[key, value]] : [];
      }),
    ),
    ...(Array.isArray(record.rpcArgs)
      ? { rpcArgs: record.rpcArgs.filter((value): value is string => typeof value === "string") }
      : {}),
    ...(rpcEnv ? { rpcEnv } : {}),
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
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...readProviderSessionFields(record),
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
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...readProviderSessionFields(params),
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

import type { AgentRuntimeSessionCodec } from "@rudderhq/agent-runtime-utils";

export { ensureCursorSkillsInjected, execute } from "./execute.js";
export { runtimeProviderCapabilities } from "./native-capabilities.js";
export {
  createCursorLocalProviderCapabilities,
  createCursorLocalProviderCapabilityResolver,
  resolveCursorLocalProviderCapabilities,
  CursorNativeCapabilityError,
} from "./native-capabilities.js";
export type {
  CursorCapabilityEvidence,
  CursorLocalProfileTransport,
  CursorLocalProfileTransportResolver,
  CursorNativeTranscriptReadRequest,
  CursorNativeTranscriptReadResult,
  CursorProviderBindingRef,
  CursorProviderSessionRef,
  CursorRuntimeProviderCapabilityAdapter,
} from "./native-capabilities.js";
export { isCursorUnknownSessionError, parseCursorJsonl } from "./parse.js";
export { listCursorSkills, syncCursorSkills } from "./skills.js";
export { testEnvironment } from "./test.js";

const PROVIDER_SESSION_FIELDS = [
  "profileHostId",
  "profileId",
  "capabilityRevision",
  "cursorAcpTransport",
  "cursorAcpCommand",
  "cursorAcpProtocolVersion",
  "cursorAcpAuthMethodId",
  "cursorProviderVersion",
] as const;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readProviderSessionFields(record: Record<string, unknown>): Record<string, unknown> {
  const fields: Array<[string, unknown]> = [];
  for (const key of PROVIDER_SESSION_FIELDS) {
    const stringValue = readNonEmptyString(record[key]);
    if (stringValue) {
      fields.push([key, stringValue]);
      continue;
    }
    const numberValue = record[key];
    if (typeof numberValue === "number" && Number.isFinite(numberValue)) fields.push([key, numberValue]);
  }
  return Object.fromEntries(fields);
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
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID)
    );
  },
};

import type {
  Agent,
  AgentDetail,
  AgentInstructionsBundle,
  AgentInstructionsFileDetail,
  AgentSkillEntry,
  AgentSkillAnalytics,
  AgentSkillSnapshot,
  AgentRuntimeEnvironmentTestResult,
  AgentKeyCreated,
  AgentRuntimeState,
  AgentTaskSession,
  HeartbeatRun,
  Approval,
  AgentConfigRevision,
  OrganizationSkillCreateRequest,
} from "@rudderhq/shared";
import { isUuidLike, normalizeAgentUrlKey } from "@rudderhq/shared";
import { ApiError, api } from "./client";

export interface AgentKey {
  id: string;
  name: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AgentRuntimeModel {
  id: string;
  label: string;
}

export interface ClaudeLoginResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  loginUrl: string | null;
  stdout: string;
  stderr: string;
}

export interface OrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  reports: OrgNode[];
}

export interface AgentHireResponse {
  agent: Agent;
  approval: Approval | null;
}

export interface AgentNameSuggestion {
  name: string;
}

export interface AgentPermissionUpdate {
  canCreateAgents: boolean;
  canAssignTasks: boolean;
}

function withCompanyScope(path: string, orgId?: string) {
  if (!orgId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}orgId=${encodeURIComponent(orgId)}`;
}

function agentPath(id: string, orgId?: string, suffix = "") {
  return withCompanyScope(`/agents/${encodeURIComponent(id)}${suffix}`, orgId);
}

export const agentsApi = {
  list: (orgId: string) => api.get<Agent[]>(`/orgs/${orgId}/agents`),
  suggestName: (orgId: string) =>
    api.get<AgentNameSuggestion>(`/orgs/${encodeURIComponent(orgId)}/agents/name-suggestion`),
  org: (orgId: string) => api.get<OrgNode[]>(`/orgs/${orgId}/org`),
  listConfigurations: (orgId: string) =>
    api.get<Record<string, unknown>[]>(`/orgs/${orgId}/agent-configurations`),
  get: async (id: string, orgId?: string) => {
    try {
      return await api.get<AgentDetail>(agentPath(id, orgId));
    } catch (error) {
      // Backward-compat fallback: if backend shortname lookup reports ambiguity,
      // resolve using organization agent list while ignoring terminated agents.
      if (
        !(error instanceof ApiError) ||
        error.status !== 409 ||
        !orgId ||
        isUuidLike(id)
      ) {
        throw error;
      }

      const urlKey = normalizeAgentUrlKey(id);
      if (!urlKey) throw error;

      const agents = await api.get<Agent[]>(`/orgs/${orgId}/agents`);
      const matches = agents.filter(
        (agent) => agent.status !== "terminated" && normalizeAgentUrlKey(agent.urlKey) === urlKey,
      );
      if (matches.length !== 1) throw error;
      return api.get<AgentDetail>(agentPath(matches[0]!.id, orgId));
    }
  },
  getConfiguration: (id: string, orgId?: string) =>
    api.get<Record<string, unknown>>(agentPath(id, orgId, "/configuration")),
  listConfigRevisions: (id: string, orgId?: string) =>
    api.get<AgentConfigRevision[]>(agentPath(id, orgId, "/config-revisions")),
  getConfigRevision: (id: string, revisionId: string, orgId?: string) =>
    api.get<AgentConfigRevision>(agentPath(id, orgId, `/config-revisions/${revisionId}`)),
  rollbackConfigRevision: (id: string, revisionId: string, orgId?: string) =>
    api.post<Agent>(agentPath(id, orgId, `/config-revisions/${revisionId}/rollback`), {}),
  create: (orgId: string, data: Record<string, unknown>) =>
    api.post<Agent>(`/orgs/${orgId}/agents`, data),
  hire: (orgId: string, data: Record<string, unknown>) =>
    api.post<AgentHireResponse>(`/orgs/${orgId}/agent-hires`, data),
  update: (id: string, data: Record<string, unknown>, orgId?: string) =>
    api.patch<Agent>(agentPath(id, orgId), data),
  uploadAvatar: async (id: string, file: File, orgId?: string) => {
    const buffer = await file.arrayBuffer();
    const safeFile = new File([buffer], file.name, { type: file.type });
    const form = new FormData();
    form.append("file", safeFile);
    return api.postForm<Agent>(agentPath(id, orgId, "/avatar"), form);
  },
  updatePermissions: (id: string, data: AgentPermissionUpdate, orgId?: string) =>
    api.patch<AgentDetail>(agentPath(id, orgId, "/permissions"), data),
  instructionsBundle: (id: string, orgId?: string) =>
    api.get<AgentInstructionsBundle>(agentPath(id, orgId, "/instructions-bundle")),
  updateInstructionsBundle: (
    id: string,
    data: {
      mode?: "managed" | "external";
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    },
    orgId?: string,
  ) => api.patch<AgentInstructionsBundle>(agentPath(id, orgId, "/instructions-bundle"), data),
  instructionsFile: (id: string, relativePath: string, orgId?: string) =>
    api.get<AgentInstructionsFileDetail>(
      agentPath(id, orgId, `/instructions-bundle/file?path=${encodeURIComponent(relativePath)}`),
    ),
  saveInstructionsFile: (
    id: string,
    data: { path: string; content: string; clearLegacyPromptTemplate?: boolean },
    orgId?: string,
  ) => api.put<AgentInstructionsFileDetail>(agentPath(id, orgId, "/instructions-bundle/file"), data),
  deleteInstructionsFile: (id: string, relativePath: string, orgId?: string) =>
    api.delete<AgentInstructionsBundle>(
      agentPath(id, orgId, `/instructions-bundle/file?path=${encodeURIComponent(relativePath)}`),
    ),
  pause: (id: string, orgId?: string) => api.post<Agent>(agentPath(id, orgId, "/pause"), {}),
  resume: (id: string, orgId?: string) => api.post<Agent>(agentPath(id, orgId, "/resume"), {}),
  terminate: (id: string, orgId?: string) => api.post<Agent>(agentPath(id, orgId, "/terminate"), {}),
  remove: (id: string, orgId?: string) => api.delete<{ ok: true }>(agentPath(id, orgId)),
  listKeys: (id: string, orgId?: string) => api.get<AgentKey[]>(agentPath(id, orgId, "/keys")),
  skills: (id: string, orgId?: string) =>
    api.get<AgentSkillSnapshot>(agentPath(id, orgId, "/skills")),
  skillsAnalytics: (
    id: string,
    options?: { orgId?: string; windowDays?: number; startDate?: string; endDate?: string },
  ) => {
    const params = new URLSearchParams();
    if (options?.windowDays) params.set("windowDays", String(options.windowDays));
    if (options?.startDate) params.set("startDate", options.startDate);
    if (options?.endDate) params.set("endDate", options.endDate);
    const suffix = params.size > 0 ? `/skills/analytics?${params.toString()}` : "/skills/analytics";
    return api.get<AgentSkillAnalytics>(agentPath(id, options?.orgId, suffix));
  },
  createPrivateSkill: (id: string, payload: OrganizationSkillCreateRequest, orgId?: string) =>
    api.post<AgentSkillEntry>(agentPath(id, orgId, "/skills/private"), payload),
  syncSkills: (id: string, desiredSkills: string[], orgId?: string) =>
    api.post<AgentSkillSnapshot>(agentPath(id, orgId, "/skills/sync"), { desiredSkills }),
  createKey: (id: string, name: string, orgId?: string) =>
    api.post<AgentKeyCreated>(agentPath(id, orgId, "/keys"), { name }),
  revokeKey: (agentId: string, keyId: string, orgId?: string) =>
    api.delete<{ ok: true }>(agentPath(agentId, orgId, `/keys/${encodeURIComponent(keyId)}`)),
  runtimeState: (id: string, orgId?: string) =>
    api.get<AgentRuntimeState>(agentPath(id, orgId, "/runtime-state")),
  taskSessions: (id: string, orgId?: string) =>
    api.get<AgentTaskSession[]>(agentPath(id, orgId, "/task-sessions")),
  resetSession: (id: string, taskKey?: string | null, orgId?: string) =>
    api.post<void>(agentPath(id, orgId, "/runtime-state/reset-session"), { taskKey: taskKey ?? null }),
  adapterModels: (orgId: string, type: string) =>
    api.get<AgentRuntimeModel[]>(
      `/orgs/${encodeURIComponent(orgId)}/adapters/${encodeURIComponent(type)}/models`,
    ),
  testEnvironment: (
    orgId: string,
    type: string,
    data: { agentRuntimeConfig: Record<string, unknown> },
  ) =>
    api.post<AgentRuntimeEnvironmentTestResult>(
      `/orgs/${orgId}/adapters/${type}/test-environment`,
      data,
    ),
  invoke: (id: string, orgId?: string) => api.post<HeartbeatRun>(agentPath(id, orgId, "/heartbeat/invoke"), {}),
  wakeup: (
    id: string,
    data: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
    },
    orgId?: string,
  ) => api.post<HeartbeatRun | { status: "skipped" }>(agentPath(id, orgId, "/wakeup"), data),
  loginWithClaude: (id: string, orgId?: string) =>
    api.post<ClaudeLoginResult>(agentPath(id, orgId, "/claude-login"), {}),
  availableSkills: () =>
    api.get<{ skills: AvailableSkill[] }>("/skills/available"),
};

export interface AvailableSkill {
  name: string;
  description: string;
  isRudderManaged: boolean;
}

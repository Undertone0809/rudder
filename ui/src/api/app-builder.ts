import type {
  AppBuilderApp,
  AppBuilderOpaqueBinding,
  AppBuilderRunKind,
  AppBuilderBuildStatus,
} from "@rudderhq/shared";
import { api, ApiError } from "./client";

function projectAppBuilderPath(projectId: string, suffix = "") {
  return `/projects/${encodeURIComponent(projectId)}/app-builder${suffix}`;
}

function appBuilderPath(orgId: string, appId: string, suffix = "") {
  return `/app-builder/${encodeURIComponent(appId)}${suffix}?orgId=${encodeURIComponent(orgId)}`;
}

export const appBuilderApi = {
  list: (orgId: string) =>
    api.get<AppBuilderApp[]>(`/orgs/${encodeURIComponent(orgId)}/app-builder`),

  async get(projectId: string): Promise<AppBuilderApp | null> {
    try {
      return await api.get<AppBuilderApp>(projectAppBuilderPath(projectId));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },

  create: (
    orgId: string,
    input: {
      name: string;
      projectId?: string | null;
      conversationId?: string | null;
      sourceRoot: string;
      scaffoldVersion: string;
    },
  ) => api.post<AppBuilderApp>(
    `/orgs/${encodeURIComponent(orgId)}/app-builder`,
    input,
  ),

  createForProject: (
    projectId: string,
    input: {
      name: string;
      conversationId?: string | null;
      sourceRoot: string;
      scaffoldVersion: string;
    },
  ) => api.post<AppBuilderApp>(projectAppBuilderPath(projectId), input),

  updateBuild: (
    orgId: string,
    appId: string,
    input: {
      status: AppBuilderBuildStatus;
      expectedStatus?: AppBuilderBuildStatus;
      runId?: string | null;
      runKind?: AppBuilderRunKind;
    },
  ) => api.patch<AppBuilderApp>(appBuilderPath(orgId, appId, "/build"), input),

  attachConversation: (orgId: string, appId: string, conversationId: string) =>
    api.patch<AppBuilderApp>(
      appBuilderPath(orgId, appId, "/conversation"),
      { conversationId },
    ),

  bindLocalRuntime: (orgId: string, appId: string, binding: AppBuilderOpaqueBinding) =>
    api.put<AppBuilderApp>(appBuilderPath(orgId, appId, "/local-binding"), binding),

  clearLocalRuntime: (orgId: string, appId: string) =>
    api.delete<AppBuilderApp>(appBuilderPath(orgId, appId, "/local-binding")),
};

import type {
  ActivityEvent,
  Automation,
  AutomationDetail,
  AutomationListItem,
  AutomationRun,
  AutomationRunSummary,
  AutomationTrigger,
  AutomationTriggerSecretMaterial,
} from "@rudderhq/shared";
import { activityApi } from "./activity";
import { api } from "./client";

export interface AutomationTriggerResponse {
  trigger: AutomationTrigger;
  secretMaterial: AutomationTriggerSecretMaterial | null;
}

export interface RotateAutomationTriggerResponse {
  trigger: AutomationTrigger;
  secretMaterial: AutomationTriggerSecretMaterial;
}

export const automationsApi = {
  list: (orgId: string) => api.get<AutomationListItem[]>(`/orgs/${orgId}/automations`),
  create: (orgId: string, data: Record<string, unknown>) =>
    api.post<Automation>(`/orgs/${orgId}/automations`, data),
  get: (id: string) => api.get<AutomationDetail>(`/automations/${id}`),
  update: (id: string, data: Record<string, unknown>) => api.patch<Automation>(`/automations/${id}`, data),
  listRuns: (id: string, limit: number = 50) => api.get<AutomationRunSummary[]>(`/automations/${id}/runs?limit=${limit}`),
  createTrigger: (id: string, data: Record<string, unknown>) =>
    api.post<AutomationTriggerResponse>(`/automations/${id}/triggers`, data),
  updateTrigger: (id: string, data: Record<string, unknown>) =>
    api.patch<AutomationTrigger>(`/automation-triggers/${id}`, data),
  deleteTrigger: (id: string) => api.delete<void>(`/automation-triggers/${id}`),
  rotateTriggerSecret: (id: string) =>
    api.post<RotateAutomationTriggerResponse>(`/automation-triggers/${id}/rotate-secret`, {}),
  run: (id: string, data?: Record<string, unknown>) =>
    api.post<AutomationRun>(`/automations/${id}/run`, data ?? {}),
  activity: async (
    orgId: string,
    automationId: string,
    related?: { triggerIds?: string[]; runIds?: string[] },
  ) => {
    const requests = [
      activityApi.list(orgId, { entityType: "automation", entityId: automationId }),
      ...(related?.triggerIds ?? []).map((triggerId) =>
        activityApi.list(orgId, { entityType: "automation_trigger", entityId: triggerId })),
      ...(related?.runIds ?? []).map((runId) =>
        activityApi.list(orgId, { entityType: "automation_run", entityId: runId })),
    ];
    const events = (await Promise.all(requests)).flat();
    const deduped = new Map(events.map((event) => [event.id, event]));
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  },
};

import type { Approval, ApprovalComment, Issue } from "@rudderhq/shared";
import { api } from "./client";

export const approvalsApi = {
  list: (orgId: string, status?: string) =>
    api.get<Approval[]>(
      `/orgs/${orgId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  create: (orgId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/orgs/${orgId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/approve`, { decisionNote }),
  reject: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/reject`, { decisionNote }),
  requestRevision: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, { decisionNote }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
};

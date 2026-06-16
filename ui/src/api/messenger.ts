import type {
  MessengerApprovalThreadItem,
  MessengerCustomGroup,
  MessengerCustomGroupEntry,
  MessengerCustomGroupsResponse,
  MessengerEvent,
  MessengerIssueThreadItem,
  MessengerSystemThreadKind,
  MessengerThreadDetail,
  MessengerThreadSummary,
  MessengerThreadSummaryPage,
} from "@rudderhq/shared";
import { api } from "./client";

type MessengerThreadDetailResponse<TItem> = {
  summary: MessengerThreadSummary;
  detail: MessengerThreadDetail<TItem>;
};

type MessengerIssuesThreadOptions = {
  cursor?: string | null;
  limit?: number;
};

type MessengerThreadsOptions = {
  cursor?: string | null;
  limit?: number;
  splitIssues?: boolean;
};

export const messengerApi = {
  listThreads: (orgId: string) =>
    api.get<MessengerThreadSummary[]>(`/orgs/${orgId}/messenger/threads`),
  listThreadPage: (orgId: string, options: MessengerThreadsOptions = {}) => {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (typeof options.limit === "number") params.set("limit", String(options.limit));
    if (options.splitIssues) params.set("splitIssues", "true");
    const query = params.toString();
    return api.get<MessengerThreadSummaryPage>(`/orgs/${orgId}/messenger/threads${query ? `?${query}` : ""}`);
  },
  markThreadRead: (orgId: string, threadKey: string, lastReadAt?: string | null) =>
    api.post<{ threadKey: string; lastReadAt: string }>(
      `/orgs/${orgId}/messenger/threads/${encodeURIComponent(threadKey)}/read`,
      lastReadAt ? { lastReadAt } : {},
    ),
  updateThreadUserState: (
    orgId: string,
    threadKey: string,
    data: {
      pinned?: boolean;
    },
  ) =>
    api.post<{ threadKey: string; pinned?: boolean }>(
      `/orgs/${orgId}/messenger/threads/${encodeURIComponent(threadKey)}/user-state`,
      data,
    ),
  getIssuesThread: (orgId: string, options: MessengerIssuesThreadOptions = {}) => {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (typeof options.limit === "number") params.set("limit", String(options.limit));
    const query = params.toString();
    return api.get<MessengerThreadDetailResponse<MessengerIssueThreadItem>>(
      `/orgs/${orgId}/messenger/issues${query ? `?${query}` : ""}`,
    );
  },
  getApprovalsThread: (orgId: string) =>
    api.get<MessengerThreadDetailResponse<MessengerApprovalThreadItem>>(`/orgs/${orgId}/messenger/approvals`),
  getSystemThread: (orgId: string, threadKind: MessengerSystemThreadKind) =>
    api.get<MessengerThreadDetailResponse<MessengerEvent>>(`/orgs/${orgId}/messenger/system/${threadKind}`),
  listCustomGroups: (orgId: string) =>
    api.get<MessengerCustomGroupsResponse>(`/orgs/${orgId}/messenger/groups`),
  createCustomGroup: (orgId: string, data: { name: string }) =>
    api.post<MessengerCustomGroup>(`/orgs/${orgId}/messenger/groups`, data),
  updateCustomGroup: (orgId: string, groupId: string, data: { name?: string; collapsed?: boolean; sortOrder?: number }) =>
    api.patch<MessengerCustomGroup>(`/orgs/${orgId}/messenger/groups/${groupId}`, data),
  deleteCustomGroup: (orgId: string, groupId: string) =>
    api.delete<MessengerCustomGroup>(`/orgs/${orgId}/messenger/groups/${groupId}`),
  reorderCustomGroups: (orgId: string, groupIds: string[]) =>
    api.patch<MessengerCustomGroupsResponse>(`/orgs/${orgId}/messenger/groups/reorder`, { groupIds }),
  assignCustomGroupEntry: (orgId: string, groupId: string, threadKey: string) =>
    api.post<MessengerCustomGroupEntry>(`/orgs/${orgId}/messenger/groups/${groupId}/entries`, { threadKey }),
  removeCustomGroupEntry: (orgId: string, threadKey: string) =>
    api.delete<{ threadKey: string }>(`/orgs/${orgId}/messenger/groups/entries/${encodeURIComponent(threadKey)}`),
  reorderCustomGroupEntries: (orgId: string, groupId: string, threadKeys: string[]) =>
    api.patch<MessengerCustomGroupsResponse>(`/orgs/${orgId}/messenger/groups/${groupId}/entries/reorder`, { threadKeys }),
};

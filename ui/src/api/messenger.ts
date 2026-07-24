import type {
  MessengerApprovalThreadItem,
  MessengerCustomGroup,
  MessengerCustomGroupEntry,
  MessengerCustomGroupsResponse,
  MessengerIssueThreadItem,
  MessengerSavedView,
  MessengerSavedViewKeepResult,
  MessengerSavedViewPage,
  MessengerSavedViewPlacement,
  MessengerSavedViewTarget,
  MessengerSystemThreadItem,
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

type SavedViewVisibility = "visible" | "hidden" | "all";
type SavedViewCreateInput = {
  target: MessengerSavedViewTarget;
  title: string;
  subtitle?: string | null;
  favicon?: string | null;
};
type SavedViewUpdateInput = Partial<Omit<SavedViewCreateInput, "target">> & {
  target?: MessengerSavedViewTarget;
  hidden?: false;
  primaryRailPinned?: boolean;
};
type SavedViewKeepInput = SavedViewCreateInput & {
  clientMutationId: string;
  placement: MessengerSavedViewPlacement;
};

export const messengerApi = {
  listSavedViews: (
    orgId: string,
    options: {
      visibility?: SavedViewVisibility;
      limit?: number;
      offset?: number;
      primaryRailPinned?: true;
    } = {},
  ) => {
    const params = new URLSearchParams({ visibility: options.visibility ?? "visible" });
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    if (options.primaryRailPinned !== undefined) params.set("primaryRailPinned", String(options.primaryRailPinned));
    return api.get<MessengerSavedViewPage>(`/orgs/${orgId}/messenger/saved-views?${params.toString()}`);
  },
  getSavedView: (orgId: string, savedViewId: string) =>
    api.get<MessengerSavedView>(`/orgs/${orgId}/messenger/saved-views/${savedViewId}`),
  keepSavedView: (orgId: string, data: SavedViewKeepInput) =>
    api.post<MessengerSavedViewKeepResult>(`/orgs/${orgId}/messenger/saved-views/keep`, data),
  createSavedView: (orgId: string, data: SavedViewCreateInput) =>
    api.post<MessengerSavedView>(`/orgs/${orgId}/messenger/saved-views`, data),
  updateSavedView: (orgId: string, savedViewId: string, data: SavedViewUpdateInput) =>
    api.patch<MessengerSavedView>(`/orgs/${orgId}/messenger/saved-views/${savedViewId}`, data),
  reorderSavedViews: (orgId: string, ids: string[]) =>
    api.patch<MessengerSavedViewPage>(`/orgs/${orgId}/messenger/saved-views/reorder`, { ids }),
  deleteSavedView: (orgId: string, savedViewId: string) =>
    api.delete<MessengerSavedView>(`/orgs/${orgId}/messenger/saved-views/${savedViewId}`),
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
  dismissUnreads: (orgId: string) =>
    api.post<{ dismissedCount: number; dismissedThreadKeys: string[] }>(
      `/orgs/${orgId}/messenger/unreads/dismiss`,
      {},
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
    api.get<MessengerThreadDetailResponse<MessengerSystemThreadItem>>(`/orgs/${orgId}/messenger/system/${threadKind}`),
  listCustomGroups: (orgId: string) =>
    api.get<MessengerCustomGroupsResponse>(`/orgs/${orgId}/messenger/groups`),
  createCustomGroup: (orgId: string, data: { name: string; icon?: string | null }) =>
    api.post<MessengerCustomGroup>(`/orgs/${orgId}/messenger/groups`, data),
  createCustomGroupWithEntries: (orgId: string, data: { name: string; icon?: string | null; itemKeys?: string[]; threadKeys?: string[]; anchorItemKey?: string; autoGenerateName?: boolean }) =>
    api.post<MessengerCustomGroupsResponse>(`/orgs/${orgId}/messenger/groups/merge`, data),
  updateCustomGroup: (orgId: string, groupId: string, data: { name?: string; icon?: string | null; collapsed?: boolean; pinned?: boolean; sortOrder?: number }) =>
    api.patch<MessengerCustomGroup>(`/orgs/${orgId}/messenger/groups/${groupId}`, data),
  regenerateCustomGroupTitle: (orgId: string, groupId: string) =>
    api.post<MessengerCustomGroup>(`/orgs/${orgId}/messenger/groups/${groupId}/title/regenerate`, {}),
  separateCustomGroup: (orgId: string, groupId: string) =>
    api.post<MessengerCustomGroup>(`/orgs/${orgId}/messenger/groups/${groupId}/separate`, {}),
  deleteCustomGroup: (orgId: string, groupId: string) =>
    api.delete<MessengerCustomGroup>(`/orgs/${orgId}/messenger/groups/${groupId}`),
  reorderCustomGroups: (orgId: string, groupIds: string[]) =>
    api.patch<MessengerCustomGroupsResponse>(`/orgs/${orgId}/messenger/groups/reorder`, { groupIds }),
  assignCustomGroupEntry: (orgId: string, groupId: string, itemKey: string) =>
    api.post<MessengerCustomGroupEntry>(`/orgs/${orgId}/messenger/groups/${groupId}/entries`, { itemKey }),
  removeCustomGroupEntry: (orgId: string, itemKey: string) =>
    api.delete<{ itemKey: string; threadKey?: string }>(`/orgs/${orgId}/messenger/groups/entries/${encodeURIComponent(itemKey)}`),
  reorderCustomGroupEntries: (orgId: string, groupId: string, itemKeys: string[]) =>
    api.patch<MessengerCustomGroupsResponse>(`/orgs/${orgId}/messenger/groups/${groupId}/entries/reorder`, { itemKeys }),
};

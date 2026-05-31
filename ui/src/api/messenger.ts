import type {
  MessengerApprovalThreadItem,
  MessengerEvent,
  MessengerIssueThreadItem,
  MessengerSystemThreadKind,
  MessengerThreadDetail,
  MessengerThreadSummaryPage,
  MessengerThreadSummary,
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
};

export const messengerApi = {
  listThreads: (orgId: string) =>
    api.get<MessengerThreadSummary[]>(`/orgs/${orgId}/messenger/threads`),
  listThreadPage: (orgId: string, options: MessengerThreadsOptions = {}) => {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (typeof options.limit === "number") params.set("limit", String(options.limit));
    const query = params.toString();
    return api.get<MessengerThreadSummaryPage>(`/orgs/${orgId}/messenger/threads${query ? `?${query}` : ""}`);
  },
  markThreadRead: (orgId: string, threadKey: string, lastReadAt?: string | null) =>
    api.post<{ threadKey: string; lastReadAt: string }>(
      `/orgs/${orgId}/messenger/threads/${encodeURIComponent(threadKey)}/read`,
      lastReadAt ? { lastReadAt } : {},
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
};

import type {
  MessengerApprovalThreadItem,
  MessengerEvent,
  MessengerIssueThreadItem,
  MessengerSystemThreadKind,
  MessengerThreadDetail,
  MessengerThreadSummary,
} from "@rudderhq/shared";
import { api } from "./client";

type MessengerThreadDetailResponse<TItem> = {
  summary: MessengerThreadSummary;
  detail: MessengerThreadDetail<TItem>;
};

export const messengerApi = {
  listThreads: (orgId: string) =>
    api.get<MessengerThreadSummary[]>(`/orgs/${orgId}/messenger/threads`),
  markThreadRead: (orgId: string, threadKey: string, lastReadAt?: string | null) =>
    api.post<{ threadKey: string; lastReadAt: string }>(
      `/orgs/${orgId}/messenger/threads/${encodeURIComponent(threadKey)}/read`,
      lastReadAt ? { lastReadAt } : {},
    ),
  getIssuesThread: (orgId: string) =>
    api.get<MessengerThreadDetailResponse<MessengerIssueThreadItem>>(`/orgs/${orgId}/messenger/issues`),
  getApprovalsThread: (orgId: string) =>
    api.get<MessengerThreadDetailResponse<MessengerApprovalThreadItem>>(`/orgs/${orgId}/messenger/approvals`),
  getSystemThread: (orgId: string, threadKind: MessengerSystemThreadKind) =>
    api.get<MessengerThreadDetailResponse<MessengerEvent>>(`/orgs/${orgId}/messenger/system/${threadKind}`),
};

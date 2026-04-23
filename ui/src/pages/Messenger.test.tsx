// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MessengerApprovalsView,
  MessengerIssuesView,
  MessengerSystemView,
} from "./Messenger";

const invalidateQueries = vi.fn();
const mutate = vi.fn();

let messengerModel: any;

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate, isPending: false }),
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("@/hooks/useMessenger", () => ({
  useMessengerModel: () => messengerModel,
  messengerThreadKindLabel: (kind: string) => kind,
  resolveMessengerRoute: () => ({ kind: "root" }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/messenger" }),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams()],
  useParams: () => ({}),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/components/ApprovalCard", () => ({
  ApprovalCard: ({
    approval,
    supportingText,
    detailLabel,
  }: {
    approval: { type: string };
    supportingText?: string | null;
    detailLabel?: string;
  }) => (
    <div data-testid="mock-approval-card">
      <div>{approval.type}</div>
      <div>{supportingText}</div>
      <div>{detailLabel}</div>
    </div>
  ),
}));

vi.mock("@/components/ApprovalDetailDialog", () => ({
  ApprovalDetailDialog: () => null,
}));

function baseModel() {
  return {
    currentUserId: "user-1",
    selectedOrganizationId: "org-1",
    threadSummaries: [],
    issueThreadDetail: null,
    approvalThreadDetail: null,
    systemThreadDetail: null,
    isLoading: false,
    error: null,
  };
}

describe("Messenger page headers", () => {
  beforeEach(() => {
    messengerModel = baseModel();
    invalidateQueries.mockReset();
    mutate.mockReset();
  });

  it("renders the Issues header without an unread counter", () => {
    messengerModel.issueThreadDetail = {
      title: "Issues",
      description: "Followed issues, issues I created, and issues assigned to me.",
      unreadCount: 3,
      items: [
        {
          id: "issue-item-1",
          issueId: "issue-1",
          issueIdentifier: "RUD-1",
          title: "RUD-1 · Messenger issue follow",
          subtitle: "followed",
          body: "This issue is watched from Messenger.",
          preview: "This issue is watched from Messenger.",
          href: "/issues/RUD-1",
          latestActivityAt: "2026-04-11T10:00:00.000Z",
          actions: [],
          metadata: {
            status: "todo",
            priority: "medium",
            followed: true,
            createdByMe: false,
            assignedToMe: false,
          },
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerIssuesView />);

    expect(html).toContain("Issues");
    expect(html).toContain("Followed issues, issues I created, and issues assigned to me.");
    expect(html).toContain("Messenger issue follow");
    expect(html).not.toContain("Assign to me");
    expect(html).not.toContain("3 unread");
  });

  it("suppresses the self-assigned label when the issue was also created by me", () => {
    messengerModel.issueThreadDetail = {
      title: "Issues",
      description: "Followed issues, issues I created, and issues assigned to me.",
      unreadCount: 1,
      items: [
        {
          id: "issue-item-2",
          issueId: "issue-2",
          issueIdentifier: "RUD-2",
          title: "RUD-2 · Doc release",
          subtitle: "created by me",
          body: "Keep Messenger labels concise.",
          preview: "Keep Messenger labels concise.",
          href: "/issues/RUD-2",
          latestActivityAt: "2026-04-19T01:23:00.000Z",
          actions: [],
          metadata: {
            status: "todo",
            priority: "medium",
            followed: false,
            createdByMe: true,
            assignedToMe: true,
          },
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerIssuesView />);

    expect(html).toContain("created by me");
    expect(html).not.toContain("created by me · assigned to me");
    expect(html).not.toContain("assigned to me</span>");
  });

  it("keeps the assigned label for issues created by someone else", () => {
    messengerModel.issueThreadDetail = {
      title: "Issues",
      description: "Followed issues, issues I created, and issues assigned to me.",
      unreadCount: 1,
      items: [
        {
          id: "issue-item-3",
          issueId: "issue-3",
          issueIdentifier: "RUD-3",
          title: "RUD-3 · Review handoff",
          subtitle: "assigned to me",
          body: "Another actor assigned this issue to me.",
          preview: "Another actor assigned this issue to me.",
          href: "/issues/RUD-3",
          latestActivityAt: "2026-04-19T02:10:00.000Z",
          actions: [],
          metadata: {
            status: "todo",
            priority: "medium",
            followed: false,
            createdByMe: false,
            assignedToMe: true,
          },
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerIssuesView />);

    expect(html).toContain("assigned to me");
    expect(html).not.toContain("created by me · assigned to me");
  });

  it("renders the Approvals header without pending or total counters", () => {
    messengerModel.approvalThreadDetail = {
      title: "Approvals",
      description: "Approval objects stay inside the thread so decisions happen without losing context.",
      unreadCount: 2,
      items: [
        {
          id: "approval-item-1",
          title: "Budget override",
          subtitle: "Approval update",
          body: "Budget override approval",
          preview: "Budget override approval",
          href: "/messenger/approvals/appr-1",
          latestActivityAt: "2026-04-11T10:00:00.000Z",
          actions: [],
          metadata: {},
          approval: {
            id: "appr-1",
            type: "budget_override_required",
            status: "pending",
          },
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerApprovalsView />);

    expect(html).toContain("Approvals");
    expect(html).toContain("Approval objects stay inside the thread so decisions happen without losing context.");
    expect(html).toContain("budget_override_required");
    expect(html).toContain("Open full approval");
    expect(html).not.toContain("2 pending");
    expect(html).not.toContain("1 total");
  });

  it("renders a system header without an items counter", () => {
    messengerModel.systemThreadDetail = {
      title: "Failed runs",
      description: "Recent failed heartbeat runs",
      unreadCount: 4,
      items: [
        {
          id: "run-1",
          kind: "failed-runs",
          title: "Run failed for Messenger worker",
          subtitle: "Failed heartbeat run",
          body: "Process exited with code 1.",
          preview: "Process exited with code 1.",
          href: "/heartbeats/run-1",
          latestActivityAt: "2026-04-11T10:00:00.000Z",
          actions: [
            { label: "Retry", href: "/api/heartbeat-runs/run-1/retry", method: "POST" },
            { label: "Open run", href: "/heartbeats/run-1", method: "GET" },
          ],
          metadata: {
            contextSnapshot: {
              issueId: "issue-1",
              issue: { title: "Recover the failed workspace bootstrap" },
            },
          },
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerSystemView threadKind="failed-runs" />);

    expect(html).toContain("Failed runs");
    expect(html).toContain("Recent failed heartbeat runs");
    expect(html).toContain("Run failed for Messenger worker");
    expect(html).toContain("Recover the failed workspace bootstrap");
    expect(html).toContain('href="/issues/issue-1"');
    expect(html).toContain('data-variant="outline"');
    expect(html).not.toContain("Open issue");
    expect(html).not.toContain("Issue issue-1");
    expect(html).not.toContain("1 items");
  });
});

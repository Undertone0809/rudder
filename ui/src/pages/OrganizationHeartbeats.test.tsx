// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrganizationHeartbeats } from "./OrganizationHeartbeats";

const invalidateQueries = vi.fn();
const pushToast = vi.fn();
const mutate = vi.fn();

const agents = [
  {
    id: "agent-live",
    orgId: "org-1",
    name: "Nia",
    urlKey: "nia",
    role: "ceo",
    title: "CEO",
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: true, canAssignTasks: true },
    lastHeartbeatAt: new Date("2026-04-18T10:00:00.000Z"),
    metadata: null,
    createdAt: new Date("2026-04-18T09:00:00.000Z"),
    updatedAt: new Date("2026-04-18T10:00:00.000Z"),
  },
  {
    id: "agent-off",
    orgId: "org-1",
    name: "Rosalie",
    urlKey: "rosalie",
    role: "engineer",
    title: "Founding Engineer",
    icon: null,
    status: "active",
    reportsTo: "agent-live",
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0 } },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false, canAssignTasks: true },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-18T09:00:00.000Z"),
    updatedAt: new Date("2026-04-18T10:00:00.000Z"),
  },
  {
    id: "agent-configured-inactive",
    orgId: "org-1",
    name: "Blake",
    urlKey: "blake",
    role: "designer",
    title: "Design Lead",
    icon: null,
    status: "active",
    reportsTo: "agent-live",
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0 } },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false, canAssignTasks: true },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-18T09:00:00.000Z"),
    updatedAt: new Date("2026-04-18T10:00:00.000Z"),
  },
];

const runs = [
  {
    id: "run-live",
    orgId: "org-1",
    agentId: "agent-live",
    invocationSource: "timer",
    triggerDetail: "system",
    status: "running",
    startedAt: new Date("2026-04-18T10:01:00.000Z"),
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: { summary: "Reviewing organization priorities." },
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    createdAt: new Date("2026-04-18T10:01:00.000Z"),
    updatedAt: new Date("2026-04-18T10:01:00.000Z"),
  },
];

const liveRuns = [
  {
    id: "run-live",
    status: "running",
    invocationSource: "timer",
    triggerDetail: "system",
    startedAt: "2026-04-18T10:01:00.000Z",
    finishedAt: null,
    createdAt: "2026-04-18T10:01:00.000Z",
    agentId: "agent-live",
    agentName: "Nia",
    agentRuntimeType: "codex_local",
    issueId: null,
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "agents") {
      return { data: agents, isLoading: false, error: null };
    }
    if (queryKey[0] === "heartbeats") {
      return { data: runs, isLoading: false, error: null };
    }
    if (queryKey[0] === "live-runs") {
      return { data: liveRuns, isLoading: false, error: null };
    }
    return { data: null, isLoading: false, error: null };
  },
  useMutation: () => ({
    mutate,
    isPending: false,
    variables: undefined,
  }),
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("@/hooks/useViewedOrganization", () => ({
  useViewedOrganization: () => ({
    viewedOrganizationId: "org-1",
    viewedOrganization: {
      id: "org-1",
      issuePrefix: "R3",
      name: "R3",
    },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

describe("OrganizationHeartbeats", () => {
  it("renders agent controls and recent activity without the removed hero summary", () => {
    const html = renderToStaticMarkup(<OrganizationHeartbeats />);

    expect(html).not.toContain("Monitor the agents in R3");
    expect(html).not.toContain("No recent summary available.");
    expect(html).not.toContain("No summary available.");
    expect(html).toContain("Nia");
    expect(html).toContain("Rosalie");
    expect(html).toContain("Blake");
    expect(html).toContain("Live now");
    expect(html).toContain("Configured, inactive");
    expect(html).toContain("Disabled");
    expect(html).toMatch(
      /Timer heartbeat state for Blake[\s\S]*?aria-pressed="false"[^>]*>On<\/button>[\s\S]*?aria-pressed="true"[^>]*>Off<\/button>/,
    );
    expect(html).toContain("Run now");
    expect(html).toContain("Recent activity");
  });
});

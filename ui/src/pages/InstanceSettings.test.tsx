// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InstanceSettings } from "./InstanceSettings";

const invalidateQueries = vi.fn();
const mutate = vi.fn();

const schedulerAgents = [
  {
    id: "agent-1",
    orgId: "org-1",
    organizationName: "R1",
    organizationIssuePrefix: "R1",
    agentName: "Wyatt",
    agentUrlKey: "wyatt",
    role: "ceo",
    title: "CEO",
    status: "active",
    agentRuntimeType: "codex_local",
    intervalSec: 3600,
    heartbeatEnabled: false,
    schedulerActive: false,
    lastHeartbeatAt: null,
  },
  {
    id: "agent-configured-inactive",
    orgId: "org-1",
    organizationName: "R1",
    organizationIssuePrefix: "R1",
    agentName: "Blake",
    agentUrlKey: "blake",
    role: "designer",
    title: "Design Lead",
    status: "active",
    agentRuntimeType: "codex_local",
    intervalSec: 0,
    heartbeatEnabled: true,
    schedulerActive: false,
    lastHeartbeatAt: null,
  },
  {
    id: "agent-2",
    orgId: "org-2",
    organizationName: "Rudder Studio",
    organizationIssuePrefix: "RUD",
    agentName: "Blake",
    agentUrlKey: "blake",
    role: "designer",
    title: "Design Lead",
    status: "active",
    agentRuntimeType: "codex_local",
    intervalSec: 1800,
    heartbeatEnabled: true,
    schedulerActive: true,
    lastHeartbeatAt: new Date("2026-04-18T10:00:00.000Z"),
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: schedulerAgents,
    isLoading: false,
    error: null,
  }),
  useMutation: () => ({
    mutate,
    isPending: false,
    variables: undefined,
  }),
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      (
        {
          "common.systemSettings": "System settings",
          "common.heartbeats": "Heartbeats",
          "heartbeats.title": "Heartbeats",
          "heartbeats.description": "Review scheduler heartbeats.",
          "heartbeats.summary.scheduled": "scheduled",
          "heartbeats.summary.configuredInactive": "configured inactive",
          "heartbeats.summary.disabled": "disabled",
          "heartbeats.summary.organization": "organization",
          "heartbeats.summary.organizations": "organizations",
          "heartbeats.disableAll": "Disable All",
          "heartbeats.disabling": "Disabling...",
          "heartbeats.confirmDisableAll.one": `Disable ${params?.count ?? 0} enabled agent?`,
          "heartbeats.confirmDisableAll.many": `Disable ${params?.count ?? 0} enabled agents?`,
          "heartbeats.empty": "No heartbeats.",
          "heartbeats.section.title": "Scheduled agents",
          "heartbeats.section.description": "Grouped by organization.",
          "heartbeats.table.agent": "Agent",
          "heartbeats.table.scheduler": "Scheduler",
          "heartbeats.table.lastHeartbeat": "Last heartbeat",
          "heartbeats.table.actions": "Actions",
          "heartbeats.table.interval": "Interval",
          "heartbeats.scheduler.scheduled": "Scheduled",
          "heartbeats.scheduler.configuredInactive": "Configured, inactive",
          "heartbeats.scheduler.disabled": "Disabled",
          "heartbeats.never": "never",
          "heartbeats.updateFailed": "Failed to update heartbeat.",
          "heartbeats.disableAllFailed": "Failed to disable all heartbeats.",
          "heartbeats.timerState": "Timer heartbeat state",
          "heartbeats.on": "On",
          "heartbeats.off": "Off",
        } as Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

describe("InstanceSettings", () => {
  it("links each organization group header to that organization's heartbeat page", () => {
    const html = renderToStaticMarkup(<InstanceSettings />);

    expect(html).toContain('href="/R1/heartbeats"');
    expect(html).toContain('href="/RUD/heartbeats"');
    expect(html).toContain(">R1<");
    expect(html).toContain(">Rudder Studio<");
  });

  it("renders interval-zero configured heartbeats with the off state selected", () => {
    const html = renderToStaticMarkup(<InstanceSettings />);

    expect(html).toMatch(/Configured, inactive[\s\S]*Interval 0s/);
    expect(html).toMatch(/Interval 0s[\s\S]*aria-pressed="false"[\s\S]*>On<\/button>[\s\S]*aria-pressed="true"[\s\S]*>Off<\/button>/);
  });
});

// @vitest-environment node

import type { CostByAgent, CostByProject, CostTrendPoint } from "@rudderhq/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CostTrendChart } from "./Costs";

describe("CostTrendChart", () => {
  it("exposes exact daily cost data on each trend bar", () => {
    const rows: CostTrendPoint[] = [
      {
        date: "2026-05-07",
        costCents: 42,
        inputTokens: 1_000,
        cachedInputTokens: 250,
        outputTokens: 75,
        totalTokens: 1_075,
        eventCount: 3,
      },
    ];

    const html = renderToStaticMarkup(
      <CostTrendChart rows={rows} from="2026-05-07T00:00:00.000Z" to="2026-05-07T23:59:59.999Z" />,
    );

    expect(html).toContain(
      'aria-label="May 7, 2026: 1,075 tokens (1,000 input, 250 cached, 75 output), $0.42 estimated spend, 3 events"',
    );
    expect(html).toContain("data-slot=\"tooltip-trigger\"");
    expect(html).toContain("Tokens");
    expect(html).toContain("Estimated spend");
  });

  it("renders agent and project trend filters when options are available", () => {
    const agentOptions = [
      {
        agentId: "agent-1",
        agentName: "Ella",
        agentIcon: null,
        agentRole: "engineer",
        agentStatus: "active",
        costCents: 0,
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        apiRunCount: 1,
        subscriptionRunCount: 0,
        subscriptionCachedInputTokens: 0,
        subscriptionInputTokens: 0,
        subscriptionOutputTokens: 0,
      },
    ] satisfies CostByAgent[];
    const projectOptions = [
      {
        projectId: "project-1",
        projectName: "Rudder mkt",
        costCents: 0,
        inputTokens: 20,
        cachedInputTokens: 0,
        outputTokens: 4,
      },
    ] satisfies CostByProject[];

    const html = renderToStaticMarkup(
      <CostTrendChart
        rows={[]}
        agentOptions={agentOptions}
        projectOptions={projectOptions}
        filterKind="agent"
        selectedAgentId="agent-1"
        onFilterKindChange={() => {}}
      />,
    );

    expect(html).toContain(">All</button>");
    expect(html).toContain(">Agent</button>");
    expect(html).toContain(">Project</button>");
    expect(html).toContain('aria-label="Filter trend by agent"');
    expect(html).toContain("Ella");
  });
});

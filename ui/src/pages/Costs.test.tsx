// @vitest-environment node

import type { CostByAgent, CostByProject, CostTrendPoint } from "@rudderhq/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CostTrendChart, calculateCostTrendInitialScrollLeft } from "./Costs";
import { buildDistributionItems } from "./Costs.distribution";

describe("CostTrendChart", () => {
  it("exposes daily cost data on each trend bar", () => {
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
      'aria-label="May 7, 2026: 1.1K tokens (750 uncached input, 250 cached, 75 output), $0.42 estimated spend, 3 events"',
    );
    expect(html).toContain("data-slot=\"tooltip-trigger\"");
    expect(html).toContain("Tokens");
    expect(html).toContain("Estimated spend");
    expect(html).toContain("data-testid=\"cost-trend-scale\"");
  });

  it("renders compact token units in the trend tooltip", () => {
    const rows: CostTrendPoint[] = [
      {
        date: "2026-06-13",
        costCents: 230,
        inputTokens: 299_639_485,
        cachedInputTokens: 280_413_568,
        outputTokens: 1_200_287,
        totalTokens: 300_839_772,
        eventCount: 138,
      },
    ];

    const html = renderToStaticMarkup(
      <CostTrendChart rows={rows} from="2026-06-13T00:00:00.000Z" to="2026-06-13T23:59:59.999Z" />,
    );

    expect(html).toContain(
      'aria-label="Jun 13, 2026: 300.8M tokens (19.2M uncached input, 280.4M cached, 1.2M output), $2.30 estimated spend, 138 events"',
    );
  });

  it("renders hourly buckets with a complete local-time tooltip", () => {
    const rows: CostTrendPoint[] = [{
      date: "2026-06-19T01:00:00.000Z",
      costCents: 125,
      inputTokens: 900,
      cachedInputTokens: 300,
      outputTokens: 100,
      totalTokens: 1_000,
      eventCount: 2,
    }];

    const html = renderToStaticMarkup(
      <CostTrendChart
        rows={rows}
        from="2026-06-19T01:00:00.000Z"
        to="2026-06-19T01:59:59.999Z"
        granularity="hour"
      />,
    );

    expect(html).toContain("Hourly token volume");
    expect(html).toContain("1.0K tokens");
    expect(html).toContain("$1.25 estimated spend");
  });

  it("renders all agent trend series when the agent filter is selected", () => {
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
      {
        agentId: "agent-2",
        agentName: "Mina",
        agentIcon: null,
        agentRole: "engineer",
        agentStatus: "active",
        costCents: 5,
        inputTokens: 8,
        cachedInputTokens: 0,
        outputTokens: 3,
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
        from="2026-05-07T00:00:00.000Z"
        to="2026-05-07T23:59:59.999Z"
        agentSeries={[
          {
            agent: agentOptions[0],
            rows: [{
              date: "2026-05-07",
              costCents: 7,
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              eventCount: 1,
            }],
          },
          {
            agent: agentOptions[1],
            rows: [{
              date: "2026-05-07",
              costCents: 5,
              inputTokens: 8,
              cachedInputTokens: 0,
              outputTokens: 3,
              totalTokens: 11,
              eventCount: 1,
            }],
          },
        ]}
        agentOptions={agentOptions}
        projectOptions={projectOptions}
        filterKind="agent"
        onFilterKindChange={() => {}}
      />,
    );

    expect(html).toContain(">All</button>");
    expect(html).toContain(">Agent</button>");
    expect(html).toContain(">Project</button>");
    expect(html).not.toContain('aria-label="Filter trend by agent"');
    expect(html).toContain("2 agents");
    expect(html).toContain("Ella");
    expect(html).toContain("Mina");
    expect(html).toContain("May 7, 2026: Ella 15 tokens, $0.07; Mina 11 tokens, $0.05");
  });

  it("aligns an overflowing trend chart to the latest day with data", () => {
    expect(calculateCostTrendInitialScrollLeft({
      dayCount: 30,
      targetDayIndex: 29,
      scrollWidth: 1_052,
      clientWidth: 360,
    })).toBe(692);

    expect(calculateCostTrendInitialScrollLeft({
      dayCount: 30,
      targetDayIndex: 24,
      scrollWidth: 1_052,
      clientWidth: 360,
    })).toBe(537);
  });

  it("keeps the trend chart at the left edge when the target is already visible", () => {
    expect(calculateCostTrendInitialScrollLeft({
      dayCount: 30,
      targetDayIndex: 0,
      scrollWidth: 1_052,
      clientWidth: 360,
    })).toBe(0);

    expect(calculateCostTrendInitialScrollLeft({
      dayCount: 30,
      targetDayIndex: 29,
      scrollWidth: 360,
      clientWidth: 360,
    })).toBe(0);
  });
});

describe("buildDistributionItems", () => {
  it("groups long tails into Other while preserving the selected metric total", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: `agent-${index}`,
      label: `Agent ${index}`,
      tokens: 800 - index * 50,
      costCents: 80 - index * 5,
    }));

    const items = buildDistributionItems(rows, "tokens");

    expect(items).toHaveLength(6);
    expect(items.at(-1)?.label).toBe("Other (3)");
    expect(items.reduce((sum, item) => sum + item.value, 0)).toBe(
      rows.reduce((sum, row) => sum + row.tokens, 0),
    );
  });

  it("keeps extremely small shares visible in accessible legend data", () => {
    const items = buildDistributionItems([
      { id: "large", label: "Large", tokens: 999_999, costCents: 100 },
      { id: "tiny", label: "Tiny", tokens: 1, costCents: 1 },
    ], "tokens");

    expect(items[1]?.percentage).toBeGreaterThan(0);
    expect(items[1]?.label).toBe("Tiny");
  });
});

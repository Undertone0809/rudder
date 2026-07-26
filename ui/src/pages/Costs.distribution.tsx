import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCents, formatTokens } from "@/lib/utils";
import { useMemo, useState } from "react";

type DistributionMetric = "tokens" | "cost";

export type DistributionDatum = {
  id: string;
  label: string;
  tokens: number;
  costCents: number;
};

type DistributionItem = DistributionDatum & {
  color: string;
  value: number;
  percentage: number;
};

const distributionPalette = [
  "#2563eb",
  "#06b6d4",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#e11d48",
];

export function buildDistributionItems(
  rows: DistributionDatum[],
  metric: DistributionMetric,
  visibleLimit = 5,
): DistributionItem[] {
  const valueFor = (row: DistributionDatum) => metric === "tokens" ? row.tokens : row.costCents;
  const sorted = rows
    .filter((row) => valueFor(row) > 0)
    .slice()
    .sort((a, b) => valueFor(b) - valueFor(a));
  const total = sorted.reduce((sum, row) => sum + valueFor(row), 0);
  const visible = sorted.length > visibleLimit + 1 ? sorted.slice(0, visibleLimit) : sorted;
  const hidden = sorted.length > visibleLimit + 1 ? sorted.slice(visibleLimit) : [];
  const grouped: DistributionDatum[] = hidden.length > 0
    ? [
        ...visible,
        {
          id: "other",
          label: `Other (${hidden.length})`,
          tokens: hidden.reduce((sum, row) => sum + row.tokens, 0),
          costCents: hidden.reduce((sum, row) => sum + row.costCents, 0),
        },
      ]
    : visible;

  return grouped.map((row, index) => {
    const value = valueFor(row);
    return {
      ...row,
      value,
      percentage: total > 0 ? (value / total) * 100 : 0,
      color: distributionPalette[index % distributionPalette.length]!,
    };
  });
}

function distributionGradient(items: DistributionItem[]): string {
  const visualWeights = items.map((item) => Math.max(item.percentage, 0.5));
  const visualTotal = visualWeights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  const stops = items.map((item, index) => {
    const start = cursor;
    cursor += visualTotal > 0 ? (visualWeights[index]! / visualTotal) * 100 : 0;
    return `${item.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

export function DistributionPanel({
  title,
  description,
  rows,
}: {
  title: string;
  description: string;
  rows: DistributionDatum[];
}) {
  const [metric, setMetric] = useState<DistributionMetric>("tokens");
  const items = useMemo(() => buildDistributionItems(rows, metric), [metric, rows]);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const accessibleSummary = items
    .map((item) => `${item.label} ${item.percentage.toFixed(1)}%`)
    .join(", ");

  return (
    <Card data-testid={`distribution-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardHeader className="gap-3 px-5 pb-2 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="mt-1">{description}</CardDescription>
          </div>
          <div
            className="flex rounded-[calc(var(--radius-sm)-1px)] border border-border p-0.5"
            role="group"
            aria-label={`${title} metric`}
          >
            {(["tokens", "cost"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={metric === value}
                onClick={() => setMetric(value)}
                className={cn(
                  "rounded-[calc(var(--radius-sm)-2px)] px-2.5 py-1 text-xs font-medium transition-colors",
                  metric === value
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "tokens" ? "Token" : "Cost"}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        {items.length === 0 ? (
          <div className="flex min-h-52 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] border border-dashed border-border text-sm text-muted-foreground">
            No usage in this period.
          </div>
        ) : (
          <div className="grid items-center gap-5 sm:grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.2fr)]">
            <div
              role="img"
              aria-label={`${title}: ${accessibleSummary}`}
              className="relative mx-auto aspect-square w-full max-w-44 rounded-full"
              style={{ background: distributionGradient(items) }}
            >
              <div className="absolute inset-[23%] flex flex-col items-center justify-center rounded-full bg-card px-2 text-center shadow-[0_0_0_1px_hsl(var(--border))]">
                <span className="max-w-full truncate text-lg font-semibold tabular-nums">
                  {metric === "tokens" ? formatTokens(total) : formatCents(total)}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {metric === "tokens" ? "Total tokens" : "Estimated cost"}
                </span>
              </div>
            </div>
            <div className="min-w-0 space-y-2.5">
              {items.map((item) => (
                <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
                    <span className="truncate" title={item.label}>{item.label}</span>
                  </div>
                  <div className="text-right tabular-nums">
                    <div className="font-medium">
                      {metric === "tokens" ? formatTokens(item.value) : formatCents(item.value)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {item.percentage < 0.1 ? "<0.1%" : `${item.percentage.toFixed(1)}%`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

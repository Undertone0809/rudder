import type { IssueLabel } from "@rudderhq/shared";

export const ISSUE_LABEL_COLOR_PALETTE = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
] as const;

export function normalizeIssueLabelName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

export function findIssueLabelExactMatch(labels: IssueLabel[], query: string) {
  const normalizedQuery = normalizeIssueLabelName(query).toLowerCase();
  if (!normalizedQuery) return null;
  return labels.find((label) => normalizeIssueLabelName(label.name).toLowerCase() === normalizedQuery) ?? null;
}

export function pickIssueLabelColor(name: string) {
  const normalized = normalizeIssueLabelName(name);
  if (!normalized) return ISSUE_LABEL_COLOR_PALETTE[0];
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return ISSUE_LABEL_COLOR_PALETTE[hash % ISSUE_LABEL_COLOR_PALETTE.length]!;
}

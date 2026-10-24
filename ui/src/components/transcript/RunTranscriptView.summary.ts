import { compactWhitespace, truncate } from "./RunTranscriptView.common";

export function quoteSummaryText(value: string, max = 48): string {
  return `"${truncate(compactWhitespace(value), max)}"`;
}

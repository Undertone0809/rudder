// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatExactTimestamp, HoverTimestampLabel } from "./HoverTimestamp";

describe("HoverTimestampLabel", () => {
  it("keeps one stable relative label while exposing the exact timestamp", () => {
    const date = "2026-04-11T09:40:00.000Z";
    const exactLabel = formatExactTimestamp(date);
    const html = renderToStaticMarkup(
      <HoverTimestampLabel date={date} label="just now" testId="message-timestamp" />,
    );

    expect(html).toContain('data-testid="message-timestamp"');
    expect(html).toContain(`title="${exactLabel}"`);
    expect(html).toContain(`aria-label="${exactLabel}"`);
    expect(html).toContain(">just now</span>");
    expect(html.match(/just now/g)).toHaveLength(1);
    expect(html).not.toContain("inline-grid");
    expect(html).not.toContain("group-hover:opacity");
  });
});

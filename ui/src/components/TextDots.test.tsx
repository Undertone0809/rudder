import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextDots } from "./TextDots";

describe("TextDots", () => {
  it("renders fixed-width current-color trailing dots for inline loading text", () => {
    const html = renderToStaticMarkup(<TextDots text="Thinking" className="text-muted-foreground" />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Thinking..."');
    expect(html).toContain("Thinking");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("rudder-text-dots__dots");
    expect(html.match(/class="rudder-text-dots__dot"/g)).toHaveLength(3);
    expect(html).toContain("--rudder-text-dot-index:0");
    expect(html).toContain("--rudder-text-dot-index:1");
    expect(html).toContain("--rudder-text-dot-index:2");
  });
});

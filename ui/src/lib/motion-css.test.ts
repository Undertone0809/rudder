import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const motionCss = readFileSync(new URL("../motion.css", import.meta.url), "utf8");

describe("Motion V1 CSS", () => {
  it("defines reduced-motion fallbacks for repeated product motion", () => {
    expect(motionCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(motionCss).toContain(".motion-live-surface::before");
    expect(motionCss).toContain('.motion-kanban-card[data-live="true"]');
    expect(motionCss).toContain('.motion-org-edge[data-active="true"]');
    expect(motionCss).toContain("animation: none !important");
  });
});

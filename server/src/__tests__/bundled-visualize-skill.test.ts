import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillRoot = path.join(
  process.cwd(),
  "server/resources/bundled-skills/visualize",
);

describe("bundled Rudder visualize skill", () => {
  it("ships a concise Rudder-native skill contract and its synchronized resources", async () => {
    const [skill, runtimeContract, openaiMetadata, example] = await Promise.all([
      fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
      fs.readFile(path.join(skillRoot, "references/runtime-contract.md"), "utf8"),
      fs.readFile(path.join(skillRoot, "agents/openai.yaml"), "utf8"),
      fs.readFile(path.join(skillRoot, "assets/example-chart.html"), "utf8"),
    ]);

    expect(skill.split("\n").length).toBeLessThan(500);
    expect(skill).toContain("name: visualize");
    expect(skill).toContain(":::rudder-inline-visual:v1");
    expect(skill).toContain(":::rudder-inline-visual:end");
    expect(skill).toContain("references/runtime-contract.md");
    expect(skill).toContain("assets/example-chart.html");
    expect(skill).toContain("Provider-neutral and filesystem-independent");
    expect(skill).toContain("Never emit");
    expect(skill).toContain("declarative HTML, SVG, and CSS");
    expect(skill).toContain("Mermaid");
    expect(skill).not.toContain("allow-scripts");
    expect(skill).not.toContain("window.openai");
    expect(skill).not.toMatch(/https:\/\/(?:cdnjs|cdn\.jsdelivr|esm\.sh|unpkg)/);

    for (const text of [skill, runtimeContract]) {
      expect(text).toContain("64 KiB");
      expect(text).toContain("128 KiB");
      expect(text).toContain("256 KiB");
      expect(text).toContain("three");
      expect(text).toContain("scriptless");
      expect(text).toContain("data-tooltip");
      expect(text).toContain("--viz-series-1");
      expect(text).toContain("no network");
    }

    expect(runtimeContract).toContain("`<details>`");
    expect(runtimeContract).toContain("`<svg>`");
    expect(runtimeContract).toContain("`<style>`");
    expect(runtimeContract).toContain("`<script>`");
    expect(runtimeContract).toContain("`@media`");
    expect(runtimeContract).toContain("Do not use clipping paths");
    expect(runtimeContract).not.toContain("`clipPath`");
    expect(skill).not.toContain("thread-scoped visualization directory");
    expect(skill).not.toContain('::codex-inline-vis{file="<title>.html"}');
    expect(openaiMetadata).toContain('display_name: "Visualize"');
    expect(openaiMetadata).toContain('default_prompt: "Use $visualize');
    expect(example).toContain('id="widget"');
    expect(example).toContain("var(--viz-series-1)");
    expect(example).toContain("height: 118px");
    expect(example).not.toMatch(/<script|https?:\/\//i);
  });
});

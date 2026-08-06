import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillRoot = path.join(
  process.cwd(),
  "server/resources/bundled-skills/browser",
);

describe("bundled Rudder Browser skill", () => {
  it("requires explicit Browser selection before routing or use", async () => {
    const [skill, openaiMetadata, triggerEvals] = await Promise.all([
      fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
      fs.readFile(path.join(skillRoot, "agents/openai.yaml"), "utf8"),
      fs.readFile(path.join(skillRoot, "evals/trigger-evals.json"), "utf8"),
    ]);
    const evals = JSON.parse(triggerEvals) as Array<{
      query: string;
      should_trigger: boolean;
    }>;

    expect(skill).toContain("only when the user explicitly mentions or selects");
    expect(skill).toContain("not enough to invoke this skill");
    expect(skill).toContain("do not open, inspect, or interact with Rudder's Browser");
    expect(openaiMetadata).toContain("allow_implicit_invocation: false");
    expect(openaiMetadata).toContain(
      'default_prompt: "Use $browser only when the user explicitly requests',
    );

    expect(evals).toHaveLength(5);
    expect(evals.filter((item) => item.should_trigger)).toHaveLength(2);
    expect(evals.filter((item) => !item.should_trigger)).toHaveLength(3);
    expect(evals.filter((item) => item.should_trigger).every((item) =>
      /Rudder(?:'s)? (?:built-in )?Browser|\$browser/i.test(item.query),
    )).toBe(true);
    expect(evals.filter((item) => !item.should_trigger).every((item) =>
      !/Rudder(?:'s)? (?:built-in )?Browser|\$browser/i.test(item.query),
    )).toBe(true);
  });
});

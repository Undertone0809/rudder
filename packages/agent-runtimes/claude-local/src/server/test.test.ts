import { describe, expect, it } from "vitest";

describe("claude hello probe classification", () => {
  it("warns when a timed-out probe produced a completed hello result", async () => {
    const mod = await import("./test.js") as Record<string, unknown>;
    const classifyClaudeHelloProbe = mod.classifyClaudeHelloProbe as (
      input: {
        timedOut: boolean;
        exitCode: number | null;
        stdout: string;
        stderr: string;
      },
    ) => { code: string; level: string };

    const result = classifyClaudeHelloProbe({
      timedOut: true,
      exitCode: null,
      stdout: JSON.stringify({ type: "result", result: "hello" }),
      stderr: "",
    });

    expect(result).toMatchObject({
      code: "claude_hello_probe_passed_with_timeout",
      level: "warn",
    });
  });
});

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

describe("gemini testEnvironment", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("allows slow successful local probes by default", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-gemini-"));
    const command = path.join(tempDir, "gemini");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "setTimeout(() => {",
        "  process.stdout.write(JSON.stringify({ type: 'result', status: 'success', result: 'hello' }) + '\\n');",
        "}, 11_000);",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const result = await testEnvironment({
        orgId: "org-1",
        agentRuntimeType: "gemini_local",
        config: { cwd: process.cwd() },
      });

      expect(result.checks.map((check) => check.code)).toContain("gemini_hello_probe_passed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});

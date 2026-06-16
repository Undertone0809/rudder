import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

describe("cursor testEnvironment", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("uses cursor-agent as the default command", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-cursor-agent-"));
    const command = path.join(tempDir, "cursor-agent");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'result', result: 'hello', usage: {} }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const result = await testEnvironment({
        orgId: "org-1",
        agentRuntimeType: "cursor",
        config: { cwd: process.cwd() },
      });

      expect(result.checks.map((check) => check.code)).toContain("cursor_hello_probe_passed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

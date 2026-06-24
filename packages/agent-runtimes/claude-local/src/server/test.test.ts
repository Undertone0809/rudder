import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { testEnvironment } from "./test.js";

describe("claude hello probe classification", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

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

  it("runs the local claude command hello probe and classifies final text", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-claude-"));
    const command = path.join(tempDir, "claude");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'result', result: 'hello', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const result = await testEnvironment({
        orgId: "org-1",
        agentRuntimeType: "claude_local",
        config: { cwd: process.cwd() },
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          code: "claude_hello_probe_passed",
          level: "info",
          detail: "hello",
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the hello probe with managed auto permission mode by default", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-claude-"));
    const command = path.join(tempDir, "claude");
    const capturePath = path.join(tempDir, "argv.json");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdout.write(JSON.stringify({ type: 'result', result: 'hello', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const result = await testEnvironment({
        orgId: "org-1",
        agentRuntimeType: "claude_local",
        config: { cwd: process.cwd(), permissionMode: "auto" },
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          code: "claude_hello_probe_passed",
          level: "info",
        }),
      );
      const argv = JSON.parse(await readFile(capturePath, "utf8")) as string[];
      expect(argv).toContain("--permission-mode");
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(argv).toContain("--settings");
      expect(argv).toContain("--setting-sources");
      expect(argv).toContain("--strict-mcp-config");
      expect(argv).not.toContain("--dangerously-skip-permissions");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the hello probe from the same managed Claude home boundary as execution", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-claude-managed-env-"));
    const command = path.join(tempDir, "claude");
    const capturePath = path.join(tempDir, "capture.json");
    const hostClaudeDir = path.join(tempDir, ".claude");
    const hostAnthropicDir = path.join(tempDir, ".anthropic");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
        "  argv: process.argv.slice(2),",
        "  env: {",
        "    HOME: process.env.HOME,",
        "    USERPROFILE: process.env.USERPROFILE,",
        "    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,",
        "    RUDDER_CLAUDE_HOME: process.env.RUDDER_CLAUDE_HOME,",
        "    RUDDER_OPERATOR_HOME: process.env.RUDDER_OPERATOR_HOME,",
        "  },",
        "}, null, 2));",
        "process.stdout.write(JSON.stringify({ type: 'result', result: 'hello', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    await mkdir(hostClaudeDir, { recursive: true });
    await mkdir(hostAnthropicDir, { recursive: true });
    await writeFile(path.join(hostClaudeDir, "settings.json"), "{}", "utf8");
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
    const previousHome = process.env.HOME;
    const previousRudderHome = process.env.RUDDER_HOME;
    process.env.HOME = tempDir;
    process.env.RUDDER_HOME = path.join(tempDir, ".rudder");

    try {
      const result = await testEnvironment({
        orgId: "org-1",
        agentRuntimeType: "claude_local",
        config: {
          cwd: process.cwd(),
          env: {
            HOME: path.join(tempDir, "hostile-home"),
            USERPROFILE: path.join(tempDir, "hostile-userprofile"),
          },
        },
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          code: "claude_hello_probe_passed",
          level: "info",
        }),
      );
      const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
        argv: string[];
        env: Record<string, string>;
      };
      const managedHome = path.join(tempDir, ".rudder", "instances", "default", "organizations", "org-1", "claude-home");
      expect(capture.env.HOME).toBe(managedHome);
      expect(capture.env.USERPROFILE).toBe(managedHome);
      expect(capture.env.RUDDER_CLAUDE_HOME).toBe(managedHome);
      expect(capture.env.CLAUDE_CONFIG_DIR).toBe(path.join(managedHome, ".claude"));
      expect(capture.env.RUDDER_OPERATOR_HOME).toBe(tempDir);
      expect(capture.argv[capture.argv.indexOf("--settings") + 1]).toBe(path.join(managedHome, ".claude", "settings.json"));
      expect(capture.argv[capture.argv.indexOf("--setting-sources") + 1]).toBe("user");
      expect(capture.argv).toContain("--strict-mcp-config");
      await expect(lstat(path.join(managedHome, ".anthropic")).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousRudderHome;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("strips hostile permission and config overrides from hello probe extra args", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-claude-"));
    const command = path.join(tempDir, "claude");
    const capturePath = path.join(tempDir, "argv.json");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdout.write(JSON.stringify({ type: 'result', result: 'hello', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const result = await testEnvironment({
        orgId: "org-1",
        agentRuntimeType: "claude_local",
        config: {
          cwd: process.cwd(),
          permissionMode: "auto",
          extraArgs: [
            "--permission-mode",
            "bypassPermissions",
            "--permission-mode=default",
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "--tools",
            "default",
            "--tools=default",
            "--allowedTools=Bash(*)",
            "--settings",
            path.join(tempDir, "hostile-settings.json"),
            "--add-dir=/tmp/hostile-claude-add-dir",
            "--mcp-config",
            path.join(tempDir, "hostile-mcp.json"),
            "--plugin-url=https://example.invalid/hostile-plugin.zip",
          ],
        },
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          code: "claude_hello_probe_passed",
          level: "info",
        }),
      );
      const argv = JSON.parse(await readFile(capturePath, "utf8")) as string[];
      expect(argv).toContain("--permission-mode");
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(argv).not.toContain("bypassPermissions");
      expect(argv).not.toContain("--dangerously-skip-permissions");
      expect(argv).not.toContain("--allow-dangerously-skip-permissions");
      expect(argv).not.toContain("--tools");
      expect(argv).not.toContain("default");
      expect(argv.some((arg) => arg.startsWith("--tools="))).toBe(false);
      expect(argv.some((arg) => arg.startsWith("--allowedTools="))).toBe(false);
      expect(argv).toContain("--settings");
      expect(argv[argv.indexOf("--settings") + 1]).toContain("/.rudder/instances/default/organizations/org-1/claude-home/.claude/settings.json");
      expect(argv).not.toContain(path.join(tempDir, "hostile-settings.json"));
      expect(argv.some((arg) => arg.startsWith("--add-dir="))).toBe(false);
      expect(argv).not.toContain("--mcp-config");
      expect(argv.some((arg) => arg.startsWith("--plugin-url="))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

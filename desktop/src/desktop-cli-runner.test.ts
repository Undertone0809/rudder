import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("desktop CLI Node runner", () => {
  it("invokes the staged CLI and removes Electron Node mode from its environment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-desktop-cli-runner-"));
    roots.push(root);
    const runnerPath = path.join(root, "desktop-cli-runner.js");
    const sourceRunner = path.resolve(import.meta.dirname, "../scripts/desktop-cli-runner.mjs");
    await fs.copyFile(sourceRunner, runnerPath);
    await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({ type: "module" })}\n`, "utf8");
    await fs.writeFile(path.join(root, "desktop-cli.js"), [
      "export async function runCli(argv) {",
      "  console.log(JSON.stringify({ args: argv.slice(2), electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }));",
      "  return 0;",
      "}",
      "",
    ].join("\n"), "utf8");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [runnerPath, "mcp-server"], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result).toEqual({
      code: 0,
      stdout: `${JSON.stringify({ args: ["mcp-server"], electronRunAsNode: null })}\n`,
      stderr: "",
    });
  });
});

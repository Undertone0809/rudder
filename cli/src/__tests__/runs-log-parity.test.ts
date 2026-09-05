import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildMcpServerEnv, runAgentV1McpJsonRpcMessage } from "../agent-v1-mcp-server.js";
import { runCli } from "../program.js";

const execFileAsync = promisify(execFile);
const ORIGINAL_ENV = { ...process.env };
const nativeRoot = fileURLToPath(new URL("../../../native/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const nativeBinary = path.join(nativeRoot, "target", "debug", process.platform === "win32" ? "rudder-native.exe" : "rudder-native");
const tsxBinary = path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs");
const serverFixture = fileURLToPath(new URL("./fixtures/runs-log-parity-server.mjs", import.meta.url));

type Fixture = {
  source: string;
  cases: Array<{
    offset: number;
    limitBytes: number;
    content: string;
    endOffset: number;
    eof: boolean;
    nextOffset: number | null;
  }>;
};

describe("runs log Rust, API, CLI, and MCP differential fixture", () => {
  let serverProcess: ChildProcess | null = null;
  let tempRoot: string | null = null;

  beforeAll(async () => {
    await execFileAsync("cargo", ["build", "-p", "rudder-native"], {
      cwd: nativeRoot,
      timeout: 120_000,
    });
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    if (serverProcess) {
      if (serverProcess.exitCode === null) {
        const exited = new Promise<void>((resolve) => serverProcess!.once("exit", () => resolve()));
        serverProcess.kill("SIGTERM");
        await exited;
      }
      serverProcess = null;
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("preserves every shared byte page through the real native-backed HTTP surface", async () => {
    const fixture = JSON.parse(await fs.readFile(
      new URL("../../../native/fixtures/run-evidence-read-parity.json", import.meta.url),
      "utf8",
    )) as Fixture;
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runs-log-parity-"));
    process.env.RUN_LOG_BASE_PATH = path.join(tempRoot, "run-logs");
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX = "1";
    process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH = nativeBinary;
    serverProcess = spawn(process.execPath, [tsxBinary, serverFixture], {
      cwd: repoRoot,
      env: { ...process.env, EVIDENCE_SOURCE: fixture.source },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await new Promise<number>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      serverProcess!.stdout!.on("data", (chunk) => {
        stdout += String(chunk);
        const line = stdout.split(/\r?\n/, 1)[0];
        if (/^\d+$/.test(line)) resolve(Number(line));
      });
      serverProcess!.stderr!.on("data", (chunk) => { stderr += String(chunk); });
      serverProcess!.once("exit", (code) => reject(new Error(`Fixture server exited ${code}: ${stderr}`)));
      serverProcess!.once("error", reject);
    });
    const apiBase = `http://127.0.0.1:${port}`;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    for (const testCase of fixture.cases) {
      const expected = {
        runId: "run-1",
        store: "local_file",
        logRef: path.join("org-1", "agent-1", "run-1.ndjson"),
        content: testCase.content,
        endOffset: testCase.endOffset,
        eof: testCase.eof,
        ...(testCase.nextOffset === null ? {} : { nextOffset: testCase.nextOffset }),
        page: {
          offset: testCase.offset,
          limitBytes: testCase.limitBytes,
          endOffset: testCase.endOffset,
          eof: testCase.eof,
          nextOffset: testCase.nextOffset,
        },
      };

      await expect(runCli([
        process.execPath,
        "rudder",
        "runs",
        "log",
        "run-1",
        "--offset",
        String(testCase.offset),
        "--limit-bytes",
        String(testCase.limitBytes),
        "--api-base",
        apiBase,
        "--api-key",
        "runtime-key",
        "--json",
      ])).resolves.toBe(0);
      expect(JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(""))).toEqual(expected);
      stdout.mockClear();

      const mcp = await runAgentV1McpJsonRpcMessage({
        jsonrpc: "2.0",
        id: testCase.offset + 1,
        method: "tools/call",
        params: {
          name: "rudder_runs_log",
          arguments: { run: "run-1", offset: testCase.offset, limitBytes: testCase.limitBytes },
        },
      }, buildMcpServerEnv({
        RUDDER_API_URL: apiBase,
        RUDDER_API_KEY: "runtime-key",
        RUDDER_ORG_ID: "org-1",
        RUDDER_AGENT_ID: "agent-1",
        RUDDER_RUN_ID: "run-current",
      }));
      expect(mcp?.result).toMatchObject({ isError: false, structuredContent: expected });
    }
  }, 120_000);
});

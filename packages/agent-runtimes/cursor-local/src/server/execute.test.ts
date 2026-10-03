import type {
  AgentRuntimeExecutionContext,
  ResolvedManagedExternalMcpBinding,
  RudderMcpCliCommand,
  RudderMcpPreflightResult,
} from "@rudderhq/agent-runtime-utils";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute, prepareCursorAcpMcpConfiguration } from "./execute.js";
import { sessionCodec } from "./index.js";

const LEGACY_TRANSPORT = "cursor-agent-cli-context-handoff";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(behavior: "unsupported" | "missing-session" | "drop-after-prompt") {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-cursor-chat-fallback-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const acpCommand = path.join(root, "cursor-acp");
  const legacyCommand = path.join(root, "cursor-agent");
  const acpCapture = path.join(root, "acp.jsonl");
  const legacyCapture = path.join(root, "legacy.jsonl");
  await mkdir(workspace, { recursive: true });

  await writeExecutable(acpCommand, `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.RUDDER_TEST_ACP_BEHAVIOR;
const capture = process.env.RUDDER_TEST_ACP_CAPTURE_PATH;
let buffer = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function record(request) { fs.appendFileSync(capture, JSON.stringify(request) + "\\n"); }
function handle(request) {
  record(request);
  if (request.method === "initialized") return;
  if (request.method === "initialize") {
    if (mode === "unsupported") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      authMethods: [],
    } });
    return;
  }
  if (request.method === "session/load" && mode === "missing-session") {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Session not found" } });
    return;
  }
  if (request.method === "session/new") {
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "native-created-session", modes: {} } });
    return;
  }
  if (request.method === "session/prompt" && mode === "drop-after-prompt") {
    process.exit(23);
  }
  if (request.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
`);
  await writeExecutable(legacyCommand, `#!/usr/bin/env node
const fs = require("node:fs");
const capture = process.env.RUDDER_TEST_LEGACY_CAPTURE_PATH;
const prompt = fs.readFileSync(0, "utf8");
fs.appendFileSync(capture, JSON.stringify({ argv: process.argv.slice(2), prompt }) + "\\n");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "legacy-chat-session" }));
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "legacy-chat-session", result: "legacy reply" }));
`);

  return { root, workspace, acpCommand, legacyCommand, acpCapture, legacyCapture, behavior };
}

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

function makeContext(input: {
  workspace: string;
  acpCommand: string;
  legacyCommand: string;
  acpCapture: string;
  legacyCapture: string;
  behavior: "unsupported" | "missing-session" | "drop-after-prompt";
  command?: string;
  cursorAcpCommand?: string | null;
  path?: string;
  runtime?: AgentRuntimeExecutionContext["runtime"];
  logs?: string[];
  metadataNotes?: string[][];
  transcriptOrder?: string[];
}): AgentRuntimeExecutionContext {
  return {
    runId: "run-cursor-chat",
    agent: {
      id: "agent-cursor",
      orgId: "org-cursor",
      name: "Cursor Agent",
      agentRuntimeType: "cursor",
      agentRuntimeConfig: {},
    },
    runtime: input.runtime ?? { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: input.command ?? input.legacyCommand,
      ...(input.cursorAcpCommand === null
        ? {}
        : { cursorAcpCommand: input.cursorAcpCommand ?? input.acpCommand }),
      cwd: input.workspace,
      model: "auto",
      env: {
        ...(input.path ? { PATH: input.path } : {}),
        RUDDER_TEST_ACP_BEHAVIOR: input.behavior,
        RUDDER_TEST_ACP_CAPTURE_PATH: input.acpCapture,
        RUDDER_TEST_LEGACY_CAPTURE_PATH: input.legacyCapture,
      },
    },
    context: {
      chatMode: true,
      rudderSessionHandoffMarkdown: "Selected visible source: preserve only this context.",
    },
    onLog: async (_stream, chunk) => {
      if (chunk.includes("legacy reply")) input.transcriptOrder?.push("legacy output");
      input.logs?.push(chunk);
    },
    onTranscriptSource: async (source) => {
      input.transcriptOrder?.push(source);
    },
    onMeta: async (meta) => {
      input.metadataNotes?.push(meta.commandNotes ?? []);
    },
  };
}

async function isolateCursorCliPath(root: string): Promise<string> {
  await symlink(process.execPath, path.join(root, "node"));
  return root;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await readFile(filePath, "utf8");
  return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

describe("Cursor chat legacy fallback", () => {
  it("prepares native MCP from successful preflights and signed Run auth only", async () => {
    const runToken = "signed-cursor-run-token";
    const ambientToken = "ambient-token-must-not-be-used";
    const command: RudderMcpCliCommand = {
      command: "/opt/rudder/bin/rudder",
      args: ["mcp-server"],
      env: { RUDDER_API_KEY: ambientToken, RUDDER_MCP_RUDDER_BIN: "/opt/rudder/bin/rudder" },
      provenance: "desktop_bundle",
    };
    const preflight: RudderMcpPreflightResult = {
      available: true,
      provenance: "desktop_bundle",
      version: "1.0.0",
      contractVersion: "1",
      coreContractHash: "core-contract-hash",
      diagnosticCode: null,
      diagnostic: null,
      tools: [{ name: "agent.me", inputSchema: { type: "object" } }],
    };
    const managedBinding: ResolvedManagedExternalMcpBinding = {
      bindingId: "cf7ca0a0-719a-4eb3-9a19-e31758cfa56d",
      serverName: "managed-docs",
      accessMode: "read_only",
      toolPolicy: { mode: "allowlist", allowedToolNames: ["external.managed-docs.search"] },
      required: false,
      startupTimeoutMs: 3000,
      toolTimeoutMs: 10000,
      proxyUrl: "http://127.0.0.1:3100/api/mcp/runtime/bindings/cf7ca0a0-719a-4eb3-9a19-e31758cfa56d",
      bearerTokenEnvVar: "RUDDER_API_KEY",
    };
    const config = {
      managedExternalMcpBindings: [{ bindingId: managedBinding.bindingId }],
      mcpServers: [{ name: "local", command: "local-mcp", args: ["serve"] }],
    };
    const originalConfig = structuredClone(config);
    let corePreflightToken: string | undefined;
    let gatewayPreflightToken: string | undefined;
    const prepared = await prepareCursorAcpMcpConfiguration({
      config,
      runtimeEnv: {
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: ambientToken,
        RUDDER_ORG_ID: "org-cursor",
        RUDDER_AGENT_ID: "agent-cursor",
        RUDDER_RUN_ID: "run-cursor",
      },
      authToken: runToken,
      onLog: async () => {},
    }, {
      resolveRudderMcpCliCommand: async () => command,
      preflightRudderMcpServer: async (input) => {
        corePreflightToken = input.managedEnv?.RUDDER_API_KEY;
        expect(input.runtimeEnv.RUDDER_API_KEY).toBe(runToken);
        return preflight;
      },
      preflightManagedExternalMcpBindings: async (_config, env) => {
        gatewayPreflightToken = env.RUDDER_API_KEY;
        return [managedBinding];
      },
    });

    expect(corePreflightToken).toBe(runToken);
    expect(gatewayPreflightToken).toBe(runToken);
    expect(prepared.mcpServers).toContainEqual(expect.objectContaining({
      name: "rudder-tools",
      command: command.command,
      env: expect.arrayContaining([{ name: "RUDDER_API_KEY", value: runToken }]),
    }));
    expect(prepared.mcpServers).toContainEqual(expect.objectContaining({
      name: "managed-docs",
      type: "http",
      headers: [{ name: "Authorization", value: `Bearer ${runToken}` }],
    }));
    expect(prepared.mcpServers).toContainEqual({ name: "local", command: "local-mcp", args: ["serve"], env: [] });
    expect(prepared.loadedMcpServers).toEqual([
      { serverName: "rudder-tools", source: "built_in" },
      { serverName: "managed-docs", source: "managed_external" },
    ]);
    expect(config).toEqual(originalConfig);

    const noAuth = await prepareCursorAcpMcpConfiguration({
      config,
      runtimeEnv: { RUDDER_API_KEY: ambientToken },
      onLog: async () => {},
    }, {
      resolveRudderMcpCliCommand: async () => {
        throw new Error("ambient auth must not trigger Rudder MCP startup");
      },
      preflightRudderMcpServer: async () => {
        throw new Error("ambient auth must not trigger a typed-tool preflight");
      },
      preflightManagedExternalMcpBindings: async () => {
        throw new Error("ambient auth must not trigger the managed gateway");
      },
    });
    expect(noAuth.mcpServers).toEqual([{ name: "local", command: "local-mcp", args: ["serve"], env: [] }]);
    expect(noAuth.loadedMcpServers).toEqual([]);
    expect(noAuth.rudderMcp).toMatchObject({ available: false });
  });

  it("falls back only for a fresh explicit ACP unsupported result and resumes that legacy session", async () => {
    const fixture = await createFixture("unsupported");
    const logs: string[] = [];
    const metadataNotes: string[][] = [];
    const transcriptOrder: string[] = [];
    const base = {
      ...fixture,
      logs,
      metadataNotes,
      transcriptOrder,
    };

    const created = await execute(makeContext(base));

    expect(created).toMatchObject({ exitCode: 0, sessionId: "legacy-chat-session" });
    expect(created.sessionParams).toMatchObject({ cursorAcpTransport: LEGACY_TRANSPORT, cwd: fixture.workspace });
    expect(created.resultJson).toMatchObject({
      cursorSessionContinuity: "legacy",
      cursorSessionSource: "legacy_cli_context_handoff",
      cursorLegacyExecution: "fallback",
    });
    expect(String(created.resultJson && (created.resultJson as Record<string, unknown>).cursorLegacyFallbackReason)).toContain("unsupported");
    expect(logs.join("")).toContain("legacy CLI/context handoff");
    expect(logs.join("")).not.toContain("Cursor native chat failed");

    const storedParams = sessionCodec.serialize(created.sessionParams ?? null);
    expect(storedParams?.cursorAcpTransport).toBe(LEGACY_TRANSPORT);
    const acpAfterCreate = await readJsonl<{ method: string }>(fixture.acpCapture);
    expect(acpAfterCreate.map((request) => request.method)).toEqual(["initialize"]);

    const resumed = await execute(makeContext({
      ...base,
      runtime: {
        sessionId: created.sessionId ?? null,
        sessionParams: storedParams,
        sessionDisplayId: created.sessionDisplayId ?? null,
        taskKey: null,
      },
    }));

    expect(resumed).toMatchObject({ exitCode: 0, sessionId: "legacy-chat-session" });
    expect(resumed.resultJson).toMatchObject({
      cursorSessionContinuity: "legacy",
      cursorSessionSource: "legacy_cli_context_handoff",
      cursorLegacyExecution: "resume",
    });
    const legacyRuns = await readJsonl<{ argv: string[]; prompt: string }>(fixture.legacyCapture);
    expect(legacyRuns).toHaveLength(2);
    expect(legacyRuns[0]?.argv).not.toContain("--resume");
    expect(legacyRuns[1]?.argv).toContain("--resume");
    expect(legacyRuns[1]?.argv).toContain("legacy-chat-session");
    expect(legacyRuns[0]?.prompt).toContain("Selected visible source: preserve only this context.");
    expect(legacyRuns[1]?.prompt).toContain("Selected visible source: preserve only this context.");
    expect((await readJsonl<{ method: string }>(fixture.acpCapture)).map((request) => request.method)).toEqual(["initialize"]);
    expect(metadataNotes.flat().join("\n")).toContain("Resuming the saved legacy Cursor CLI/context-handoff session");
    expect(transcriptOrder).toEqual(["legacy", "legacy output", "legacy", "legacy output"]);
  });

  it("uses legacy cursor-agent when only the default ACP agent executable is missing", async () => {
    const fixture = await createFixture("unsupported");
    const isolatedPath = await isolateCursorCliPath(fixture.root);
    const result = await execute(makeContext({
      ...fixture,
      command: "cursor-agent",
      cursorAcpCommand: null,
      path: isolatedPath,
    }));

    expect(result).toMatchObject({ exitCode: 0, sessionId: "legacy-chat-session" });
    expect(result.sessionParams).toMatchObject({ cursorAcpTransport: LEGACY_TRANSPORT });
    expect(result.resultJson).toMatchObject({
      cursorSessionContinuity: "legacy",
      cursorLegacyExecution: "fallback",
    });
    expect(String(result.resultJson && (result.resultJson as Record<string, unknown>).cursorLegacyFallbackReason))
      .toContain("spawn agent ENOENT");
    expect(existsSync(fixture.acpCapture)).toBe(false);
    const legacyRuns = await readJsonl<{ argv: string[]; prompt: string }>(fixture.legacyCapture);
    expect(legacyRuns).toHaveLength(1);
    expect(legacyRuns[0]?.argv).not.toContain("--resume");
    expect(legacyRuns[0]?.prompt).toContain("Selected visible source: preserve only this context.");
  });

  it("does not fall back for ENOENT from a non-default ACP command", async () => {
    const fixture = await createFixture("unsupported");
    const isolatedPath = await isolateCursorCliPath(fixture.root);
    const result = await execute(makeContext({
      ...fixture,
      command: "cursor-agent",
      cursorAcpCommand: "missing-acp",
      path: isolatedPath,
    }));

    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_transport-error" });
    expect(result.errorMessage).toContain("spawn missing-acp ENOENT");
    expect(existsSync(fixture.legacyCapture)).toBe(false);
  });

  it("does not treat ENOENT as missing ACP capability when the agent executable exists", async () => {
    const fixture = await createFixture("unsupported");
    const isolatedPath = await isolateCursorCliPath(fixture.root);
    await writeExecutable(path.join(fixture.root, "agent"), "#!/missing/cursor-agent-interpreter\nexit 0\n");
    const result = await execute(makeContext({
      ...fixture,
      command: "cursor-agent",
      cursorAcpCommand: null,
      path: isolatedPath,
    }));

    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_transport-error" });
    expect(result.errorMessage).toContain("spawn agent ENOENT");
    expect(existsSync(fixture.legacyCapture)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("does not fall back when legacy cursor-agent is not executable", async () => {
    const fixture = await createFixture("unsupported");
    const isolatedPath = await isolateCursorCliPath(fixture.root);
    await chmod(fixture.legacyCommand, 0o644);
    const result = await execute(makeContext({
      ...fixture,
      command: "cursor-agent",
      cursorAcpCommand: null,
      path: isolatedPath,
    }));

    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_transport-error" });
    expect(result.errorMessage).toContain("spawn agent ENOENT");
    expect(existsSync(fixture.legacyCapture)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("does not fall back when the default ACP executable is not permitted", async () => {
    const fixture = await createFixture("unsupported");
    const isolatedPath = await isolateCursorCliPath(fixture.root);
    const deniedAcpCommand = path.join(fixture.root, "agent");
    await writeFile(deniedAcpCommand, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(deniedAcpCommand, 0o644);
    const result = await execute(makeContext({
      ...fixture,
      command: "cursor-agent",
      cursorAcpCommand: null,
      path: isolatedPath,
    }));

    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_transport-error" });
    expect(result.errorMessage).toContain("EACCES");
    expect(existsSync(fixture.legacyCapture)).toBe(false);
  });

  it("does not fall back when loading a saved native session fails", async () => {
    const fixture = await createFixture("missing-session");
    const sessionId = "saved-native-session";
    const result = await execute(makeContext({
      ...fixture,
      runtime: {
        sessionId,
        sessionParams: {
          sessionId,
          cwd: fixture.workspace,
          profileHostId: "local",
          profileId: "default",
          cursorAcpTransport: "cursor-agent-acp-stdio",
          cursorAcpCommand: fixture.acpCommand,
          cursorAcpProtocolVersion: 1,
        },
        sessionDisplayId: sessionId,
        taskKey: null,
      },
    }));

    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_missing-session", sessionId });
    expect((await readJsonl<{ method: string }>(fixture.acpCapture)).map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "session/load",
    ]);
    expect(existsSync(fixture.legacyCapture)).toBe(false);
  });

  it("does not replay a prompt through legacy CLI after native submission becomes uncertain", async () => {
    const fixture = await createFixture("drop-after-prompt");
    const result = await execute(makeContext(fixture));

    expect(result).toMatchObject({ exitCode: 1, sessionId: "native-created-session" });
    const methods = (await readJsonl<{ method: string }>(fixture.acpCapture)).map((request) => request.method);
    expect(methods).toContain("session/prompt");
    expect(existsSync(fixture.legacyCapture)).toBe(false);
  });
});

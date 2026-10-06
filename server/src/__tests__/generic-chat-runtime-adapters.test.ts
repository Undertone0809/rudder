import type { AgentRuntimeExecutionContext } from "@rudderhq/agent-runtime-utils";
import { AGENT_RUNTIME_TYPES } from "@rudderhq/shared";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute as executeHttp } from "../agent-runtimes/http/execute.js";
import { execute as executeProcess } from "../agent-runtimes/process/execute.js";
import { findServerAdapter, listServerAdapters } from "../agent-runtimes/registry.js";
import {
  buildChatInlineVisualPromptSection,
  CHAT_UNSUPPORTED_ADAPTER_TYPES,
} from "../services/chat-assistant.helpers.js";

const CHAT_PROTOCOL_PROMPT = buildChatInlineVisualPromptSection();

function buildContext(
  agentRuntimeType: AgentRuntimeExecutionContext["agent"]["agentRuntimeType"],
  config: Record<string, unknown>,
  overrides: Partial<AgentRuntimeExecutionContext> = {},
): AgentRuntimeExecutionContext {
  return {
    runId: "run-chat-runtime",
    agent: {
      id: "agent-chat-runtime",
      orgId: "organization-chat-runtime",
      name: "Chat Runtime",
      agentRuntimeType,
      agentRuntimeConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      chatMode: true,
      chatPrompt: CHAT_PROTOCOL_PROMPT,
      rudderChatInlineVisualProtocolVersion: 1,
    },
    onLog: async () => undefined,
    ...overrides,
  };
}

describe("generic runtime Chat conformance", () => {
  afterEach(() => {
    // Servers created by individual tests are closed in their own finally blocks.
  });

  it("exposes every registered built-in runtime to Chat", () => {
    expect([...CHAT_UNSUPPORTED_ADAPTER_TYPES]).toEqual([]);
    const adapters = listServerAdapters();
    expect(adapters.map((adapter) => adapter.type).sort()).toEqual(
      [...AGENT_RUNTIME_TYPES].sort(),
    );
  });

  it("passes the Chat prompt to process runtimes on stdin and returns stdout as final text", async () => {
    const stdout: string[] = [];
    const result = await executeProcess(buildContext("process", {
      command: process.execPath,
      args: [
        "-e",
        "let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>process.stdout.write(body));",
      ],
    }, {
      onLog: async (stream, chunk) => {
        if (stream === "stdout") stdout.push(chunk);
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(stdout.join(""))
      .toBe(CHAT_PROTOCOL_PROMPT);
    expect(result.summary)
      .toBe(CHAT_PROTOCOL_PROMPT);
  });

  it("returns an untruncated visual-sized final result from process runtimes", async () => {
    const finalText = `RUDDER_RESULT_BEGIN\n${"P".repeat(70_000)}\nRUDDER_RESULT_END`;
    const result = await executeProcess(buildContext("process", {
      command: process.execPath,
      args: [
        "-e",
        `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(finalText)}));`,
      ],
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(finalText);
    expect(result.summary?.length).toBeGreaterThan(64 * 1024);
  });

  it("returns an HTTP runtime JSON response body as Chat final text", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const httpFinalText = `RUDDER_RESULT_BEGIN\n${"W".repeat(70_000)}\nRUDDER_RESULT_END`;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestBody = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: httpFinalText }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");

    try {
      const result = await executeHttp(buildContext("http", {
        url: `http://127.0.0.1:${address.port}/chat`,
      }));

      expect(requestBody).toMatchObject({
        runId: "run-chat-runtime",
        context: {
          chatMode: true,
          chatPrompt: CHAT_PROTOCOL_PROMPT,
          rudderChatInlineVisualProtocolVersion: 1,
        },
      });
      expect(result.summary).toBe(httpFinalText);
      expect(result.resultJson).toMatchObject({
        text: httpFinalText,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("rejects an oversized HTTP runtime response before unbounded buffering", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("X".repeat((4 * 1024 * 1024) + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");

    try {
      await expect(executeHttp(buildContext("http", {
        url: `http://127.0.0.1:${address.port}/chat`,
      }))).rejects.toThrow("HTTP runtime response exceeded 4194304 bytes");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("rejects the retired Hermes Local CLI and points existing agents at Hermes Gateway", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-chat-contract-"));
    const commandPath = path.join(root, "fake-hermes.sh");
    const promptPath = path.join(root, "prompt.txt");
    await fs.writeFile(commandPath, [
      "#!/bin/sh",
      'printf "%s" "$3" > "$RUDDER_HERMES_PROMPT_CAPTURE"',
    ].join("\n"), { mode: 0o755 });

    try {
      const adapter = findServerAdapter("hermes_local");
      if (!adapter) throw new Error("Hermes adapter is not registered");
      const result = await adapter.execute(buildContext("hermes_local", {
        hermesCommand: commandPath,
        cwd: root,
        env: { RUDDER_HERMES_PROMPT_CAPTURE: promptPath },
      }));

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_local_migration_required",
        nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
        errorMessage: expect.stringContaining("hermes_gateway"),
      });
      await expect(fs.readFile(promptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

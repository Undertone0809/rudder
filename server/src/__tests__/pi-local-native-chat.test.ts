import {
  execute,
  resetPiModelsCacheForTests,
  sessionCodec,
} from "@rudderhq/agent-runtime-pi-local/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function writeFakePiRpcCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  process.stdout.write("provider  model\\nopenai    gpt-test\\n");
  process.exit(0);
}
const sessionFile = args[args.indexOf("--session") + 1];
const requestLog = path.join(process.cwd(), "pi-native-requests.jsonl");
const launchLog = path.join(process.cwd(), "pi-native-launches.jsonl");
fs.appendFileSync(launchLog, JSON.stringify(args) + "\\n");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
function respond(command, data) {
  emit({ type: "response", command, success: true, data });
}
function readEntries() {
  if (!fs.existsSync(sessionFile)) return [];
  return fs.readFileSync(sessionFile, "utf8").split(/\\r?\\n/u).filter(Boolean).map((line) => JSON.parse(line));
}
function appendEntry(entry) {
  fs.appendFileSync(sessionFile, JSON.stringify(entry) + "\\n");
}
function currentLeaf(entries) {
  const content = entries.filter((entry) => entry.type !== "session");
  const ids = new Set(content.map((entry) => entry.id));
  const parents = new Set(content.map((entry) => entry.parentId).filter((id) => id && ids.has(id)));
  return [...content].reverse().find((entry) => !parents.has(entry.id))?.id ?? null;
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(requestLog, JSON.stringify(request) + "\\n");
  if (request.type === "get_state") {
    const header = readEntries().find((entry) => entry.type === "session");
    respond("get_state", {
      sessionFile,
      sessionId: header?.id ?? "pi-native-session",
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
    });
    return;
  }
  if (request.type === "prompt") {
    respond("prompt", {});
    let entries = readEntries();
    if (!entries.some((entry) => entry.type === "session")) {
      appendEntry({ type: "session", version: 3, id: "pi-native-session", timestamp: new Date(0).toISOString(), cwd: process.cwd() });
      entries = readEntries();
    }
    const userId = "user-" + entries.filter((entry) => entry.message?.role === "user").length;
    appendEntry({ type: "message", id: userId, parentId: currentLeaf(entries), timestamp: new Date(0).toISOString(), message: { role: "user", content: request.message } });
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "answer:" + request.message }],
      usage: { input: 6, output: 2, cacheRead: 1, cost: { total: 0.002 } },
    };
    appendEntry({ type: "message", id: "assistant-" + userId, parentId: userId, timestamp: new Date(0).toISOString(), message: assistant });
    emit({ type: "message_end", message: assistant });
    emit({ type: "agent_end", willRetry: false, messages: [assistant] });
    return;
  }
  respond(request.type, {});
});
`;
  await fs.writeFile(commandPath, script, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(commandPath, 0o755);
}

describe("Pi native chat adapter", { timeout: 30_000 }, () => {
  it("continues the serialized native session and submits only each new prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-native-adapter-"));
    const workspace = path.join(root, "workspace");
    const command = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiRpcCommand(command);

    const envKeys = ["HOME", "RUDDER_OPERATOR_HOME", "RUDDER_HOME", "RUDDER_INSTANCE_ID"] as const;
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;
    process.env.RUDDER_HOME = path.join(root, ".rudder");
    process.env.RUDDER_INSTANCE_ID = "pi-native-test";
    resetPiModelsCacheForTests();

    try {
      const transportProfiles: Record<string, unknown>[] = [];
      const base = {
        agent: {
          id: "agent-pi-native",
          orgId: "org-pi-native",
          name: "Pi Native",
          agentRuntimeType: "pi",
          agentRuntimeConfig: {},
        },
        config: {
          command,
          cwd: workspace,
          model: "openai/gpt-test",
          providerVersion: "0.76.0",
          timeoutSec: 10,
          env: {},
        },
        context: {
          chatMode: true,
          rudderWorkspace: { cwd: workspace, workspaceId: "workspace-pi-native" },
        },
        authToken: "test-token",
        onNativeTransportProfile: async (profile: Record<string, unknown>) => { transportProfiles.push(profile); },
        onLog: async () => {},
      };

      await expect(execute({
        ...base,
        runId: "pi-native-extra-args-rejected",
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { ...base.config, extraArgs: ["--thinking", "medium"], promptTemplate: "not submitted" },
      })).rejects.toThrow("does not persist arbitrary extraArgs");
      await expect(execute({
        ...base,
        runId: "pi-native-legacy-args-rejected",
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { ...base.config, args: ["--thinking", "medium"], promptTemplate: "not submitted" },
      })).rejects.toThrow("does not persist arbitrary extraArgs");
      await expect(fs.access(path.join(workspace, "pi-native-launches.jsonl"))).rejects.toThrow();

      const first = await execute({
        ...base,
        runId: "pi-native-run-1",
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { ...base.config, promptTemplate: "first user message" },
      });
      const encodedParams = sessionCodec.serialize(first.sessionParams ?? null);
      expect(encodedParams).not.toBeNull();
      const resumedParams = sessionCodec.deserialize(encodedParams);
      expect(resumedParams).toMatchObject({
        transport: "pi-rpc-stdio",
        providerVersion: "0.76.0",
        workspaceId: "workspace-pi-native",
      });

      const second = await execute({
        ...base,
        runId: "pi-native-run-2",
        runtime: {
          sessionId: resumedParams?.sessionId ?? null,
          sessionParams: resumedParams,
          sessionDisplayId: first.sessionDisplayId,
          taskKey: null,
        },
        config: { ...base.config, promptTemplate: "second user message" },
      });
      const requests = (await fs.readFile(path.join(workspace, "pi-native-requests.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const launches = (await fs.readFile(path.join(workspace, "pi-native-launches.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      const sessionFile = String(first.sessionId);
      const sessionEntries = (await fs.readFile(sessionFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: string; message?: { role?: string; content?: string } });

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(first.summary).toBe("answer:first user message");
      expect(second.summary).toBe("answer:second user message");
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.sessionParams).toMatchObject({
        sessionFile,
        providerSessionId: "pi-native-session",
        previousLeafId: "assistant-user-0",
        providerVersion: "0.76.0",
      });
      expect(requests.filter((request) => request.type === "prompt").map((request) => request.message)).toEqual([
        "first user message",
        "second user message",
      ]);
      expect(sessionEntries.filter((entry) => entry.message?.role === "user").map((entry) => entry.message?.content)).toEqual([
        "first user message",
        "second user message",
      ]);
      expect(launches).toHaveLength(2);
      expect(launches.map((args) => args[args.indexOf("--session") + 1])).toEqual([sessionFile, sessionFile]);
      expect(transportProfiles).toHaveLength(2);
      expect(first.usage).toEqual({ inputTokens: 6, outputTokens: 2, cachedInputTokens: 1 });
      expect(second.usage).toEqual({ inputTokens: 6, outputTokens: 2, cachedInputTokens: 1 });
    } finally {
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetPiModelsCacheForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

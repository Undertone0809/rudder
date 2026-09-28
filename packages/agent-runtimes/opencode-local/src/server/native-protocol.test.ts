import { hasConfirmedNativeWriterQuiescence } from "@rudderhq/agent-runtime-utils";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute as executeOpenCodeAdapter } from "./execute.js";
import {
  createOpenCodeLocalProviderCapabilityResolver,
  disposeOpenCodeNativeServersForTests,
  ensureManagedOpenCodeServer,
  executeOpenCodeNativeChat,
  forkOpenCodeNativeSession,
  readOpenCodeNativeTranscript,
  runtimeProviderCapabilities,
  sessionCodec,
} from "./index.js";
import { deleteOpenCodeSideChatForkSession } from "./native-protocol.js";

const tempDirectories: string[] = [];

type FixtureMessage = {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
};

type FixtureExport = {
  info: Record<string, unknown>;
  messages: FixtureMessage[];
};

type MessageResponse = {
  status?: number;
  body?: unknown;
};

type FixtureSseEvent = {
  type: string;
  properties: Record<string, unknown>;
};

async function makeFixtureDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function managedFixtureEnv(directory: string, runId: string) {
  const managedHome = path.join(directory, "managed-home");
  return {
    HOME: directory,
    XDG_CONFIG_HOME: path.join(managedHome, ".config"),
    XDG_DATA_HOME: path.join(managedHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(managedHome, ".cache"),
    OPENCODE_CONFIG: path.join(managedHome, "runtime-tmp", runId, "opencode.json"),
  };
}

async function writeFixtureConfig(configPath: string) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, "{}", "utf8");
}

async function fixtureProcessEnvs(directory: string): Promise<Array<{ action: string; config: string | null; configContent: string | null; configDir: string | null; providerToken: string | null; runId: string | null }>> {
  const content = await fs.readFile(path.join(directory, "process-env.jsonl"), "utf8");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function makeOpenCodeFixture(directory: string, options: {
  sourceExport?: FixtureExport;
  childExport?: FixtureExport;
  messageResponse?: MessageResponse;
  streamEvents?: FixtureSseEvent[];
  waitForAbort?: boolean;
  disconnectAfterEventCount?: number;
  messageResponseDelayMs?: number;
  promptResponseDelayMs?: number;
  streamEventDelayMs?: number;
  persistPartialOnAbort?: boolean;
  partialAssistantText?: string;
  laterMessages?: FixtureMessage[];
  rejectSessionCreate?: boolean;
  rejectSessionCreateMessage?: string;
  rejectPrompt?: boolean;
  abortMode?: "stall" | "reject" | "false" | "no-content";
  exportPrefix?: string;
  exportOverride?: unknown;
  exportPadBytes?: number;
  exportDelayMs?: number;
  truncateExportBytes?: number;
  serverMessagesOverride?: unknown;
} = {}): Promise<string> {
  const command = path.join(directory, "opencode-fixture.mjs");
  const sourceExport: FixtureExport = options.sourceExport ?? {
    info: { id: "oc-session-1", time: { updated: 2 } },
    messages: [
      { info: { id: "provider-user-1", role: "user", sessionID: "oc-session-1" }, parts: [{ type: "text", text: "user input" }] },
      {
        info: { id: "provider-assistant-1", role: "assistant", parentID: "provider-user-1", sessionID: "oc-session-1", finish: "stop", time: { completed: 3 } },
        parts: [{ type: "text", text: "native answer" }],
      },
      { info: { id: "provider-user-2", role: "user", parentID: "provider-assistant-1", sessionID: "oc-session-1" }, parts: [{ type: "text", text: "later input" }] },
    ],
  };
  const childExport: FixtureExport = options.childExport ?? {
    info: { id: "oc-child", time: { updated: 3 } },
    messages: [
      {
        info: { id: "child-user-1", role: "user", sessionID: "oc-child" },
        parts: [{ id: "child-part-user", type: "text", text: "user input", sessionID: "oc-child", messageID: "child-user-1" }],
      },
      {
        info: {
          id: "child-assistant-1",
          role: "assistant",
          parentID: "child-user-1",
          sessionID: "oc-child",
          finish: "stop",
          time: { completed: 3 },
        },
        parts: [{ id: "child-part-assistant", type: "text", text: "native answer", sessionID: "oc-child", messageID: "child-assistant-1" }],
      },
    ],
  };
  const messageResponse: MessageResponse = options.messageResponse ?? {
    status: 200,
    body: {
      info: {
        id: "provider-assistant-1",
        role: "assistant",
        parentID: "provider-user-1",
        sessionID: "oc-session-1",
        time: { created: 2, completed: 3 },
        finish: "stop",
        tokens: { input: 2, output: 3 },
      },
      parts: [{ type: "text", text: "native answer" }],
      rawJsonl: "opencode-provider-raw-jsonl-secret",
      stderr: "opencode-provider-stderr-secret",
    },
  };
  const streamEvents: FixtureSseEvent[] = options.streamEvents ?? [
    { type: "session.next.prompted", properties: { sessionID: "oc-session-1", prompt: { text: "boundary test prompt" } } },
    { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "provider-assistant-1", partID: "provider-part-1", field: "text", delta: "native answer" } },
    { type: "session.idle", properties: { sessionID: "oc-session-1" } },
  ];
  await fs.writeFile(path.join(directory, "source-export.json"), JSON.stringify(sourceExport), { encoding: "utf8" });
  await fs.writeFile(path.join(directory, "current-export.json"), JSON.stringify(sourceExport), { encoding: "utf8" });
  await fs.writeFile(path.join(directory, "child-export.json"), JSON.stringify(childExport), { encoding: "utf8" });
  await fs.writeFile(path.join(directory, "message-response.json"), JSON.stringify(messageResponse), { encoding: "utf8" });
  await fs.writeFile(path.join(directory, "stream-events.json"), JSON.stringify(streamEvents), { encoding: "utf8" });
  await fs.writeFile(path.join(directory, "fixture-options.json"), JSON.stringify({
    waitForAbort: options.waitForAbort === true,
    disconnectAfterEventCount: options.disconnectAfterEventCount ?? null,
    messageResponseDelayMs: options.messageResponseDelayMs ?? 0,
    promptResponseDelayMs: options.promptResponseDelayMs ?? 0,
    streamEventDelayMs: options.streamEventDelayMs ?? 0,
    persistPartialOnAbort: options.persistPartialOnAbort === true,
    partialAssistantText: options.partialAssistantText ?? "partial R1 output",
    laterMessages: options.laterMessages ?? [],
    rejectSessionCreate: options.rejectSessionCreate === true,
    rejectSessionCreateMessage: options.rejectSessionCreateMessage ?? "Invalid session request body",
    rejectPrompt: options.rejectPrompt === true,
    abortMode: options.abortMode ?? null,
    exportPrefix: options.exportPrefix ?? "",
    exportOverride: options.exportOverride ?? null,
    exportPadBytes: options.exportPadBytes ?? 0,
    exportDelayMs: options.exportDelayMs ?? 0,
    truncateExportBytes: options.truncateExportBytes ?? null,
    serverMessagesOverride: options.serverMessagesOverride ?? null,
  }), { encoding: "utf8" });
  await fs.writeFile(command, `#!/usr/bin/env node
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
fs.writeFileSync(path.join(process.cwd(), args[0] + "-argv.json"), JSON.stringify(args));
fs.appendFileSync(path.join(process.cwd(), "process-env.jsonl"), JSON.stringify({
  action: args[0],
  config: process.env.OPENCODE_CONFIG ?? null,
  configContent: process.env.OPENCODE_CONFIG_CONTENT ?? null,
  configDir: process.env.OPENCODE_CONFIG_DIR ?? null,
  providerToken: process.env.FIXTURE_PROVIDER_TOKEN ?? null,
  runId: process.env.RUDDER_RUN_ID ?? null,
}) + "\\n");
const requestLog = path.join(process.cwd(), "requests.jsonl");
const fixtureOptions = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixture-options.json"), "utf8"));
let eventResponse = null;
let aborted = false;
let eventCount = 0;
const pendingEvents = [];
const abortWaiters = [];
const replyWaiters = new Map();

function waitForReply(requestId) {
  return new Promise((resolve) => {
    replyWaiters.set(requestId, resolve);
  });
}

function writeEvent(event) {
  if (!eventResponse) {
    pendingEvents.push(event);
    return;
  }
  eventResponse.write("data: " + JSON.stringify({ id: "fixture-event", ...event }) + "\\n\\n");
  eventCount += 1;
  if (fixtureOptions.disconnectAfterEventCount === eventCount) {
    const disconnected = eventResponse;
    eventResponse = null;
    disconnected.end();
  }
}

if (args[0] === "export") {
  if (fixtureOptions.exportDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fixtureOptions.exportDelayMs));
  const sourcePath = args[1] === "oc-session-1"
    ? path.join(process.cwd(), "current-export.json")
    : path.join(process.cwd(), "source-export.json");
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const childPath = path.join(process.cwd(), "child-export.json");
  const payload = args[1] === "oc-child" && fs.existsSync(childPath)
    ? JSON.parse(fs.readFileSync(childPath, "utf8"))
    : source;
  if (fixtureOptions.exportPadBytes) process.stdout.write(" ".repeat(fixtureOptions.exportPadBytes));
  const exported = fixtureOptions.exportPrefix + JSON.stringify(fixtureOptions.exportOverride ?? payload);
  await new Promise((resolve) => process.stdout.write(fixtureOptions.truncateExportBytes === null
    ? exported
    : exported.slice(0, fixtureOptions.truncateExportBytes), resolve));
  process.exit(0);
}

if (args[0] !== "serve") process.exit(2);

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
  const expectedAuth = "Basic " + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ":" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
  const authorized = request.headers.authorization === expectedAuth;
  fs.appendFileSync(requestLog, JSON.stringify({
    method: request.method,
    url: request.url,
    body,
    authorized,
    lastEventId: request.headers["last-event-id"] ?? null,
  }) + "\\n");
  response.setHeader("content-type", "application/json");
  if (!authorized) {
    response.statusCode = 401;
    response.end(JSON.stringify({ message: "unauthorized fixture request" }));
    return;
  }
  if (request.url?.startsWith("/global/health")) {
    response.end(JSON.stringify({ version: "fixture-opencode" }));
    return;
  }
  if (request.method === "POST" && (request.url === "/session" || request.url?.startsWith("/session?"))) {
    const sessionModel = body?.model;
    const validSessionBody = body !== null
      && typeof body === "object"
      && !Array.isArray(body)
      && Object.keys(body).every((key) => ["parentID", "title", "agent", "model", "permission", "workspaceID"].includes(key))
      && (sessionModel === undefined || (
        typeof sessionModel === "object"
        && sessionModel !== null
        && !Array.isArray(sessionModel)
        && typeof sessionModel.id === "string"
        && typeof sessionModel.providerID === "string"
        && Object.keys(sessionModel).every((key) => ["id", "providerID", "variant"].includes(key))
      ));
    if (!validSessionBody || fixtureOptions.rejectSessionCreate) {
      response.statusCode = 400;
      response.end(JSON.stringify({ message: fixtureOptions.rejectSessionCreateMessage }));
      return;
    }
    response.end(JSON.stringify({ id: "oc-session-1", projectID: "fixture" }));
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/event")) {
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    eventResponse = response;
    for (const event of pendingEvents.splice(0)) writeEvent(event);
    request.on("close", () => {
      if (eventResponse === response) eventResponse = null;
    });
    return;
  }
  if (request.method === "POST" && (request.url?.includes("/permission/") || request.url?.includes("/question/"))) {
    const match = request.url.match(/\\/(?:permission|question)\\/([^/]+)\\//);
    const requestId = match ? decodeURIComponent(match[1]) : null;
    if (requestId) {
      replyWaiters.get(requestId)?.({ body, url: request.url });
      replyWaiters.delete(requestId);
    }
    response.end(JSON.stringify(true));
    return;
  }
  if (request.method === "POST" && request.url && new URL(request.url, "http://fixture").pathname.endsWith("/abort")) {
    if (fixtureOptions.abortMode === "stall") return;
    if (fixtureOptions.abortMode === "reject") {
      response.statusCode = 503;
      response.end(JSON.stringify({ message: "fixture abort rejected" }));
      return;
    }
    if (fixtureOptions.abortMode === "false") {
      response.end(JSON.stringify(false));
      return;
    }
    aborted = true;
    for (const resolve of abortWaiters.splice(0)) resolve();
    eventResponse?.end();
    eventResponse = null;
    if (fixtureOptions.abortMode === "no-content") {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.end(JSON.stringify(true));
    return;
  }
  if (request.method === "POST" && request.url?.includes("/prompt_async")) {
    if (fixtureOptions.promptResponseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, fixtureOptions.promptResponseDelayMs));
    }
    if (fixtureOptions.rejectPrompt) {
      response.statusCode = 503;
      response.end(JSON.stringify({ message: "Prompt submission was not confirmed" }));
      return;
    }
    const promptModel = body?.model;
    const validPromptModel = promptModel === undefined || (
      typeof promptModel === "object"
      && promptModel !== null
      && !Array.isArray(promptModel)
      && typeof promptModel.providerID === "string"
      && typeof promptModel.modelID === "string"
      && Object.keys(promptModel).every((key) => ["providerID", "modelID"].includes(key))
    );
    if (!validPromptModel) {
      response.statusCode = 400;
      response.end(JSON.stringify({ message: "Invalid prompt request body" }));
      return;
    }
    response.statusCode = 204;
    response.end();
    void (async () => {
      if (fixtureOptions.messageResponseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, fixtureOptions.messageResponseDelayMs));
      }
      process.stdout.write(JSON.stringify({ type: "provider_raw_jsonl", text: "opencode-provider-stdout-secret" }) + "\\n");
      process.stderr.write("opencode-provider-stderr-secret\\n");
      const userMessageId = body?.messageID;
      if (typeof userMessageId !== "string" || !userMessageId) throw new Error("prompt_async omitted messageID");
      const assistantMessageId = "assistant-" + userMessageId;
      const configured = JSON.parse(fs.readFileSync(path.join(process.cwd(), "message-response.json"), "utf8"));
      const configuredBody = configured.body && typeof configured.body === "object" ? configured.body : {};
      const configuredInfo = configuredBody.info && typeof configuredBody.info === "object" ? configuredBody.info : {};
      const configuredParts = Array.isArray(configuredBody.parts) ? configuredBody.parts : [];
      const terminalInfo = {
        ...configuredInfo,
        id: assistantMessageId,
        role: configuredInfo.role ?? "assistant",
        parentID: userMessageId,
        sessionID: "oc-session-1",
      };
      const current = JSON.parse(fs.readFileSync(path.join(process.cwd(), "current-export.json"), "utf8"));
      current.messages.push({
        info: {
          id: userMessageId,
          role: "user",
          parentID: current.messages.at(-1)?.info?.id,
          sessionID: "oc-session-1",
        },
        parts: Array.isArray(body?.parts) ? body.parts : [],
      });
      if (!fixtureOptions.waitForAbort) {
        current.messages.push({ info: terminalInfo, parts: configuredParts });
        fs.writeFileSync(path.join(process.cwd(), "current-export.json"), JSON.stringify(current));
      } else if (fixtureOptions.persistPartialOnAbort) {
        const { finish: _finish, tokens: _tokens, ...partialInfo } = terminalInfo;
        current.messages.push({ info: partialInfo, parts: [{ type: "text", text: fixtureOptions.partialAssistantText }] });
        current.messages.push(...fixtureOptions.laterMessages.map((message) => ({
          ...message,
          info: {
            ...message.info,
            ...(message.info?.parentID === "$INTERRUPTED_ASSISTANT" ? { parentID: assistantMessageId } : {}),
          },
        })));
        fs.writeFileSync(path.join(process.cwd(), "current-export.json"), JSON.stringify(current));
      }

      const streamEvents = JSON.parse(fs.readFileSync(path.join(process.cwd(), "stream-events.json"), "utf8"));
      const sentInteractionIds = new Set();
      let idleSent = false;
      for (const event of streamEvents) {
        if (fixtureOptions.streamEventDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, fixtureOptions.streamEventDelayMs));
        }
        if (event.type === "session.idle" && !fixtureOptions.waitForAbort) {
          event.properties.sessionID = "oc-session-1";
          writeEvent(event);
          idleSent = true;
          continue;
        }
        event.properties = {
          ...event.properties,
          ...(event.properties?.sessionID ? { sessionID: "oc-session-1" } : {}),
          ...(event.properties?.messageID ? { messageID: event.properties.messageID === "$FOREIGN_ASSISTANT" ? "foreign-assistant" : assistantMessageId } : {}),
          ...(event.properties?.partID ? { partID: "part-" + userMessageId } : {}),
        };
        writeEvent(event);
        const eventType = event.type;
        if (eventType !== "permission.asked" && eventType !== "question.asked") continue;
        const requestId = event.properties?.id;
        if (typeof requestId !== "string" || sentInteractionIds.has(requestId)) continue;
        sentInteractionIds.add(requestId);
        await waitForReply(requestId);
      }
      if (fixtureOptions.waitForAbort) {
        await new Promise((resolve) => {
          if (aborted) resolve();
          else abortWaiters.push(resolve);
        });
      } else if (!idleSent) {
        writeEvent({ type: "session.idle", properties: { sessionID: "oc-session-1" } });
      }
    })().catch((error) => process.stderr.write(String(error) + "\\n"));
    return;
  }
  if (request.method === "POST" && request.url?.includes("/fork")) {
    response.end(JSON.stringify({ id: "oc-session-child", parentID: "oc-session-1" }));
    return;
  }
  if (request.method === "GET" && request.url?.includes("/session/oc-session-1/message")) {
    const current = JSON.parse(fs.readFileSync(path.join(process.cwd(), "current-export.json"), "utf8"));
    response.end(JSON.stringify(fixtureOptions.serverMessagesOverride ?? current.messages));
    return;
  }
  if (request.method === "GET" && request.url?.includes("/session/oc-session-1")) {
    response.end(JSON.stringify({ id: "oc-session-1" }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ message: "missing fixture route" }));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write("http://127.0.0.1:" + address.port + "\\n");
});
`, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(command, 0o755);
  return command;
}

function sessionFor(directory: string, command: string) {
  return {
    sessionId: "oc-session-1",
    sessionParams: {
      sessionId: "oc-session-1",
      serverUrl: "http://127.0.0.1:9",
      cwd: directory,
      serverCommand: command,
      exportCommand: command,
      exportEnv: { HOME: directory },
      transport: "opencode-managed-server-http",
      hostId: "local",
      profileId: "opencode-profile",
    },
    sessionDisplayId: "oc-session-1",
  };
}

function stubForkEndpoint(requests: Array<{ url: string; init?: RequestInit }>, childId = "oc-child") {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: childId, parentID: "oc-session-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
}

type NativeChatInput = Parameters<typeof executeOpenCodeNativeChat>[0];

async function runFixtureChat(directory: string, command: string, overrides: Partial<NativeChatInput> = {}) {
  return executeOpenCodeNativeChat({
    command,
    cwd: directory,
    env: { HOME: directory, OPENCODE_CONFIG: path.join(directory, "opencode.json") },
    prompt: "boundary test prompt",
    model: "provider/model",
    variant: "",
    session: {},
    binding: { hostId: "local", profileId: "opencode-profile" },
    timeoutSec: 10,
    onLog: async () => {},
    ...overrides,
  });
}

async function messageRequestCount(directory: string): Promise<number> {
  const content = await fs.readFile(path.join(directory, "requests.jsonl"), "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; url?: string })
    .filter((request) => request.method === "POST" && request.url?.includes("/prompt_async"))
    .length;
}

type FixtureRequest = { method: string; url?: string; body?: unknown; authorized?: boolean; lastEventId?: string | null };

async function fixtureRequests(directory: string): Promise<FixtureRequest[]> {
  const content = await fs.readFile(path.join(directory, "requests.jsonl"), "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureRequest);
}

async function waitForMessageRequest(directory: string): Promise<void> {
  await waitForValue(() => {
    try {
      const content = fsSync.readFileSync(path.join(directory, "requests.jsonl"), "utf8");
      return content.split("\n").some((line) => line.includes('"method":"POST"') && line.includes("/prompt_async"))
        ? true
        : null;
    } catch {
      return null;
    }
  });
}

async function waitForValue<T>(read: () => T | null | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fixture value.");
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await disposeOpenCodeNativeServersForTests();
  while (tempDirectories.length > 0) {
    await fs.rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("OpenCode native protocol contract", () => {
  it("uses managed server/session/message transport without --pure and persists provider identity", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-");
    const command = await makeOpenCodeFixture(directory);
    const logs: string[] = [];
    const profiles: Record<string, unknown>[] = [];
    const env = { HOME: directory, OPENCODE_CONFIG: path.join(directory, "opencode.json") };
    const result = await executeOpenCodeNativeChat({
      command,
      cwd: directory,
      env,
      prompt: "hello native",
      model: "provider/model",
      variant: "",
      session: {},
      binding: { hostId: "local", profileId: "opencode-profile" },
      timeoutSec: 10,
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onNativeTransportProfile: async (profile) => {
        const requests = await fixtureRequests(directory);
        expect(requests.some((request) => request.method === "POST" && request.url === "/session")).toBe(false);
        profiles.push(profile);
      },
    });
    const userMessageId = String(result.resultJson?.userMessageId);
    const args = JSON.parse(await fs.readFile(path.join(directory, "serve-argv.json"), "utf8")) as string[];
    expect(args.slice(0, 4)).toEqual(["serve", "--hostname", "127.0.0.1", "--port"]);
    expect(Number(args[4])).toBeGreaterThan(0);
    expect(args).not.toContain("--pure");
    expect(result.resultJson).toMatchObject({
      transport: "opencode_server",
      providerSessionId: "oc-session-1",
      userMessageId,
      providerMessageId: `assistant-${userMessageId}`,
      responsePartCount: 1,
      responsePartTypes: ["text"],
    });
    expect(result.summary).toBe("native answer");
    expect(result.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });
    expect(result.resultJson).not.toHaveProperty("response");
    expect(result.resultJson).not.toHaveProperty("stdout");
    expect(result.resultJson).not.toHaveProperty("stderr");
    const persistedResult = JSON.stringify(result.resultJson);
    expect(persistedResult).not.toContain("native answer");
    expect(persistedResult).not.toContain("opencode-provider-stdout-secret");
    expect(persistedResult).not.toContain("opencode-provider-stderr-secret");
    expect(persistedResult).not.toContain("opencode-provider-raw-jsonl-secret");
    expect(result.sessionParams).toMatchObject({
      serverCommand: command,
      exportCommand: command,
      hostId: "local",
      profileId: "opencode-profile",
    });
    expect(profiles).toHaveLength(1);
    expect(Object.keys(profiles[0] ?? {}).sort()).toEqual([
      "command",
      "cwd",
      "exportCommand",
      "exportEnv",
      "providerVersion",
      "runtimeType",
      "serverCommand",
      "serverUrl",
    ]);
    expect(profiles[0]).toMatchObject({
      runtimeType: "opencode_local",
      command,
      cwd: directory,
      exportEnv: env,
    });
    expect(profiles[0]?.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(profiles[0]).not.toHaveProperty("sessionId");
    expect(profiles[0]).not.toHaveProperty("sessionParams");
    expect(logs.join("")).toContain("OpenCode native chat completed");
    expect(logs.join("")).toContain("OpenCode native stream delta");
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureRequest);
    expect(requests.every((request) => request.authorized === true)).toBe(true);
    expect(requests.findIndex((request) => request.method === "GET" && request.url?.startsWith("/event"))).toBeGreaterThanOrEqual(0);
    expect(requests.findIndex((request) => request.method === "POST" && request.url?.includes("/prompt_async"))).toBeGreaterThan(
      requests.findIndex((request) => request.method === "GET" && request.url?.startsWith("/event")),
    );
    expect(requests.find((request) => request.method === "POST" && request.url?.includes("/prompt_async"))?.body).toMatchObject({
      messageID: userMessageId,
      parts: [{ type: "text", text: "hello native" }],
    });
    expect(requests.find((request) => request.method === "POST" && (request.url === "/session" || request.url?.startsWith("/session?")))?.body).toEqual({
      model: { id: "model", providerID: "provider" },
    });
    expect(requests.find((request) => request.method === "POST" && request.url?.includes("/prompt_async"))?.body).toMatchObject({
      model: { providerID: "provider", modelID: "model" },
    });
    expect(logs.join("")).not.toContain("opencode-provider-stdout-secret");
    expect(logs.join("")).not.toContain("opencode-provider-stderr-secret");
    expect(logs.join("")).not.toContain("opencode-provider-raw-jsonl-secret");
  });

  it("does not submit a provider prompt when local session creation returns HTTP 400", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-session-create-400-");
    const command = await makeOpenCodeFixture(directory, { rejectSessionCreate: true });
    await expect(runFixtureChat(directory, command)).rejects.toMatchObject({
      status: "unsupported",
      message: expect.stringContaining("OpenCode server 400: Invalid session request body"),
    });
    expect(await messageRequestCount(directory)).toBe(0);
  });

  it("does not echo sensitive server rejection text as a provider diagnostic", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-session-create-redacted-");
    const command = await makeOpenCodeFixture(directory, {
      rejectSessionCreate: true,
      rejectSessionCreateMessage: "Authorization Bearer private-token",
    });
    await expect(runFixtureChat(directory, command)).rejects.toMatchObject({
      status: "unsupported",
      message: "OpenCode server 400: request rejected",
    });
    expect(await messageRequestCount(directory)).toBe(0);
  });

  it("identifies structured provider errors from the session event without exposing response details", async () => {
    for (const [statusCode, errorType, message] of [
      [400, "BadRequest", "Invalid model request"],
      [401, "AuthenticationError", "Provider authentication failed"],
      [426, "UpgradeRequired", "OpenCode 1.18.0 or newer is required for the Console free tier"],
    ] as const) {
      const directory = await makeFixtureDirectory(`rudder-opencode-event-${statusCode}-`);
      const command = await makeOpenCodeFixture(directory, {
        streamEvents: [{
          type: "session.error",
          properties: {
            sessionID: "oc-session-1",
            error: {
              name: "APIError",
              message,
              data: {
                statusCode,
                responseBody: JSON.stringify({ error: { type: errorType, detail: "response-body-secret" } }),
                responseHeaders: { authorization: "header-secret" },
              },
            },
          },
        }],
      });
      const error = await runFixtureChat(directory, command).then(
        () => null,
        (value: unknown) => value as { status?: string; source?: string; message?: string },
      );
      expect(error).toMatchObject({
        status: "unknown",
        source: "provider",
        message: `OpenCode provider error: APIError HTTP ${statusCode} (${errorType}): ${message}`,
      });
      expect(error?.message).not.toMatch(/header-secret|response-body-secret|\[object Object\]/u);
      expect(await messageRequestCount(directory)).toBe(1);
    }
  });

  it("uses a generic diagnostic for malformed or secret-bearing session errors", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-event-redacted-");
    const command = await makeOpenCodeFixture(directory, {
      streamEvents: [{
        type: "session.error",
        properties: {
          sessionID: "oc-session-1",
          error: {
            name: "APIError",
            message: "Authorization Bearer private-token",
            data: {
              statusCode: 401,
              responseBody: { error: { type: "Invalid@Type", message: "response-body-secret" } },
              responseHeaders: { cookie: "header-secret" },
            },
          },
        },
      }],
    });
    const error = await runFixtureChat(directory, command).then(
      () => null,
      (value: unknown) => value as { source?: string; message?: string },
    );
    expect(error?.message).toBe("OpenCode provider error: APIError HTTP 401");
    expect(error?.source).toBe("provider");
    expect(error?.message).not.toMatch(/private-token|header-secret|response-body-secret|\[object Object\]/u);
  });

  it("does not stringify malformed session error objects", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-event-malformed-");
    const command = await makeOpenCodeFixture(directory, {
      streamEvents: [{ type: "session.error", properties: { sessionID: "oc-session-1", error: { data: { responseBody: "not-json" } } } }],
    });
    await expect(runFixtureChat(directory, command)).rejects.toMatchObject({
      source: "adapter",
      message: "OpenCode session error: Error",
    });
  });

  it("separates structured provider model failures from adapter errors without leaking secrets", async () => {
    const cases = [
      {
        name: "ProviderModelNotFoundError",
        message: "Model not found: opencode/mimo-v2.6-flash-free",
        expectedCode: "opencode_native_provider_error",
        responseBody: JSON.stringify({ error: { type: "ProviderModelNotFoundError", detail: "response-body-secret" } }),
        responseHeaders: { authorization: "header-secret" },
      },
      {
        name: "UnknownError",
        message: "Unexpected server error. Check server logs for details.",
        expectedCode: "opencode_native_unknown",
      },
    ];

    for (const testCase of cases) {
      const directory = await makeFixtureDirectory(`rudder-opencode-native-${testCase.name}-`);
      const command = await makeOpenCodeFixture(directory, {
        streamEvents: [{
          type: "session.error",
          properties: {
            sessionID: "oc-session-1",
            error: {
              name: testCase.name,
              message: testCase.message,
              data: {
                statusCode: 404,
                responseBody: testCase.responseBody,
                responseHeaders: testCase.responseHeaders,
              },
            },
          },
        }],
      });
      const logs: string[] = [];
      const result = await executeOpenCodeAdapter({
        runId: `run-${testCase.name}`,
        agent: { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command,
          cwd: directory,
          model: "opencode/mimo-v2.6-flash-free",
          promptTemplate: "{{context.chatPrompt}}",
          env: { HOME: directory },
        },
        context: { chatMode: true, chatPrompt: "fixture prompt" },
        authToken: "fixture-token",
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      });

      expect(result).toMatchObject({ exitCode: 1, errorCode: testCase.expectedCode });
      if (testCase.name === "ProviderModelNotFoundError") {
        expect(result.errorMessage).toContain("ProviderModelNotFoundError");
        expect(result.errorMessage).toContain("Model not found: opencode/mimo-v2.6-flash-free");
        expect(logs.join("")).toContain("OpenCode native chat failed (provider)");
      }
      expect(result.errorMessage).not.toMatch(/header-secret|response-body-secret|fixture-token/u);
      expect(logs.join("")).not.toMatch(/header-secret|response-body-secret|fixture-token/u);
    }
  });

  it("fails promptly when the export root has no session document schema", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-export-schema-");
    const command = await makeOpenCodeFixture(directory, {
      exportOverride: { version: "1.18.0", nested: { text: "{".repeat(4_000) } },
    });
    await expect(runFixtureChat(directory, command)).rejects.toMatchObject({
      message: "OpenCode export did not return a JSON session document.",
      sessionContext: {
        sessionId: "oc-session-1",
        submissionPhase: "accepted",
        sessionParams: { sessionId: "oc-session-1", hostId: "local", profileId: "opencode-profile" },
      },
    });
    expect(await messageRequestCount(directory)).toBe(1);
  });

  it("preserves the bound session but treats an unconfirmed prompt submission as indeterminate", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-prompt-unconfirmed-");
    const command = await makeOpenCodeFixture(directory, { rejectPrompt: true });
    await expect(runFixtureChat(directory, command)).rejects.toMatchObject({
      message: "OpenCode server 503: Prompt submission was not confirmed",
      sessionContext: {
        sessionId: "oc-session-1",
        submissionPhase: "indeterminate",
        sessionParams: { sessionId: "oc-session-1", hostId: "local", profileId: "opencode-profile" },
      },
    });
  });

  it("returns the newly created session identity on a post-submission export failure", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-adapter-export-failed-");
    const command = await makeOpenCodeFixture(directory, {
      exportOverride: { version: "1.18.0", nested: { text: "{".repeat(4_000) } },
    });
    const result = await executeOpenCodeAdapter({
      runId: "run-export-failed",
      agent: { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: directory, model: "provider/model", promptTemplate: "{{context.chatPrompt}}", env: { HOME: directory } },
      context: { chatMode: true, chatPrompt: "fixture prompt" },
      authToken: "fixture-token",
      onLog: async () => {},
    });
    expect(result).toMatchObject({
      exitCode: 1,
      submissionPhase: "accepted",
      providerThreadId: "oc-session-1",
      sessionId: "oc-session-1",
      sessionDisplayId: "oc-session-1",
      sessionParams: { sessionId: "oc-session-1", hostId: "local", profileId: "default" },
      resultJson: { providerSessionId: "oc-session-1" },
    });
  });

  it("does not treat stale same-session activity followed by idle as this input's terminal", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-stale-idle-terminal-");
    const command = await makeOpenCodeFixture(directory, {
      messageResponse: { status: 200, body: { info: { role: "user" }, parts: [{ type: "text", text: "not an assistant" }] } },
      streamEvents: [
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "$FOREIGN_ASSISTANT", delta: "older activity" } },
        { type: "session.idle", properties: { sessionID: "oc-session-1" } },
      ],
    });
    const result = await executeOpenCodeAdapter({
      runId: "run-stale-idle-terminal",
      agent: { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: directory, model: "provider/model", promptTemplate: "{{context.chatPrompt}}", env: { HOME: directory } },
      context: { chatMode: true, chatPrompt: "current input" },
      authToken: "fixture-token",
      onLog: async () => {},
    });
    expect(result).toMatchObject({
      exitCode: 1,
      submissionPhase: "accepted",
      errorMessage: expect.stringContaining("without an assistant message for the accepted input"),
      nativeWriterQuiescence: { status: "unconfirmed" },
    });
  });

  it("returns an indeterminate submission with its bound session when the prompt response is unconfirmed", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-adapter-prompt-unconfirmed-");
    const command = await makeOpenCodeFixture(directory, { rejectPrompt: true });
    const result = await executeOpenCodeAdapter({
      runId: "run-prompt-unconfirmed",
      agent: { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: directory, model: "provider/model", promptTemplate: "{{context.chatPrompt}}", env: { HOME: directory } },
      context: { chatMode: true, chatPrompt: "fixture prompt" },
      authToken: "fixture-token",
      onLog: async () => {},
    });
    expect(result).toMatchObject({
      exitCode: 1,
      submissionPhase: "indeterminate",
      providerThreadId: "oc-session-1",
      sessionId: "oc-session-1",
      sessionParams: { sessionId: "oc-session-1", hostId: "local", profileId: "default" },
    });
  });

  it("returns the observed partial boundary in the stopped adapter error result", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-adapter-partial-stop-");
    const command = await makeOpenCodeFixture(directory, {
      waitForAbort: true,
      persistPartialOnAbort: true,
      streamEvents: [
        { type: "session.next.prompted", properties: { sessionID: "oc-session-1", prompt: { text: "boundary test prompt" } } },
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "provider-assistant-r1", partID: "provider-part-r1", field: "text", delta: "R1 partial answer" } },
      ],
    });
    const abortController = new AbortController();
    let observedDelta!: () => void;
    const deltaReceived = new Promise<void>((resolve) => { observedDelta = resolve; });
    const execution = executeOpenCodeAdapter({
      runId: "run-opencode-stopped-partial",
      agent: { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: directory, model: "provider/model", promptTemplate: "{{context.chatPrompt}}", env: { HOME: directory } },
      context: { chatMode: true, chatPrompt: "boundary test prompt" },
      authToken: "fixture-token",
      abortSignal: abortController.signal,
      onLog: async (_stream, chunk) => {
        if (chunk.includes("OpenCode native stream delta")) observedDelta();
      },
    });

    await waitForMessageRequest(directory);
    await deltaReceived;
    abortController.abort(new Error("Chat Stop"));
    const result = await execution;
    expect(result).toMatchObject({
      exitCode: 1,
      sessionId: "oc-session-1",
      resultJson: {
        providerSessionId: "oc-session-1",
        userMessageId: expect.stringMatching(/^msg/u),
        transcriptBoundary: {
          status: "partial",
          observedAssistantMessageIds: [expect.stringMatching(/^assistant-msg/u)],
        },
      },
    });
  });

  it("resumes with the verified provider workspace binding when Run workspace context omits it", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-profile-workspace-resume-");
    const command = await makeOpenCodeFixture(directory);
    const managedWorkspace = path.join(directory, "managed-agent-workspace");
    const agent = { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} };
    const config = {
      command, cwd: directory, model: "provider/model", promptTemplate: "{{context.chatPrompt}}",
      env: { HOME: directory }, providerHostId: "local", providerProfileId: "profile-a",
      providerBindingId: "binding-a", providerOrgId: "organization-1", providerWorkspaceBindingId: managedWorkspace,
    };
    const run = (runId: string, sessionParams: Record<string, unknown> | null, workspaceBindingId?: string) => executeOpenCodeAdapter({
      runId, agent,
      runtime: { sessionId: sessionParams ? "oc-session-1" : null, sessionParams, sessionDisplayId: null, taskKey: null },
      config,
      context: {
        chatMode: true, chatPrompt: `message for ${runId}`,
        ...(workspaceBindingId ? { rudderWorkspace: { workspaceBindingId } } : {}),
      },
      authToken: "fixture-token", onLog: async () => {},
    });
    const first = await run("run-r1", null);
    expect(first).toMatchObject({ exitCode: 0, sessionParams: {
      workspaceBindingId: managedWorkspace, profileBindingId: "binding-a", profileOrgId: "organization-1",
    } });
    const sessionParams = first.sessionParams as Record<string, unknown>;
    const mismatched = await run("run-different-workspace", sessionParams, path.join(directory, "other-workspace"));
    expect(mismatched).toMatchObject({ exitCode: 1, errorCode: "opencode_native_unsupported" });
    const second = await run("run-r2", sessionParams);
    expect(second).toMatchObject({ exitCode: 0, sessionId: "oc-session-1", sessionParams: {
      workspaceBindingId: managedWorkspace, profileBindingId: "binding-a", profileOrgId: "organization-1",
    } });
    expect(await messageRequestCount(directory)).toBe(2);
  });

  it("restores only missing adapter-owned flags during actual Run setup before strict profile comparison", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-managed-flags-resume-");
    const command = await makeOpenCodeFixture(directory);
    const agent = { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} };
    const config = {
      command, cwd: directory, model: "provider/model", promptTemplate: "{{context.chatPrompt}}",
      env: { HOME: directory }, providerHostId: "local", providerProfileId: "profile-a",
      providerBindingId: "binding-a", providerOrgId: "organization-1",
    };
    const run = (runId: string, sessionParams: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) => executeOpenCodeAdapter({
      runId, agent,
      runtime: { sessionId: sessionParams ? "oc-session-1" : null, sessionParams, sessionDisplayId: null, taskKey: null },
      config: { ...config, ...overrides },
      context: { chatMode: true, chatPrompt: `message for ${runId}` },
      authToken: "fixture-token", onLog: async () => {},
    });
    const first = await run("run-r1", null);
    expect(first.exitCode).toBe(0);
    const firstEnv = (first.sessionParams as { exportEnv: Record<string, string> }).exportEnv;
    expect(firstEnv).toMatchObject({
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
    });
    await expect(fs.stat(firstEnv.OPENCODE_CONFIG)).rejects.toMatchObject({ code: "ENOENT" });
    const { OPENCODE_CONFIG: _oldConfig, OPENCODE_DISABLE_CLAUDE_CODE: _flag,
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: _prompt, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: _skills,
      ...stableEnv } = firstEnv;
    const resumed = { ...first.sessionParams as Record<string, unknown>, exportEnv: stableEnv };
    const failures = [
      { ...resumed, exportEnv: { ...stableEnv, HOME: path.join(directory, "other-home") } },
      { ...resumed, exportEnv: { ...stableEnv, OPENCODE_DISABLE_CLAUDE_CODE: "false" } },
      { ...resumed, exportEnv: { ...stableEnv, OPENCODE_CONFIG: path.join(directory, "foreign-config.json") } },
    ];
    for (const [index, params] of failures.entries()) {
      expect(await run(`run-drift-${index}`, params)).toMatchObject({ exitCode: 1, errorCode: "opencode_native_unsupported" });
    }
    expect(await run("run-other-org", resumed, { providerOrgId: "other-organization" }))
      .toMatchObject({ exitCode: 1, errorCode: "opencode_native_unsupported" });
    const second = await run("run-r2", resumed);
    expect(second.exitCode).toBe(0);
    const secondEnv = (second.sessionParams as { exportEnv: Record<string, string> }).exportEnv;
    expect(secondEnv).toMatchObject({ ...stableEnv,
      OPENCODE_CONFIG: expect.stringContaining(path.join("runtime-tmp", "run-r2", "opencode.json")),
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
    });
    expect(secondEnv.OPENCODE_CONFIG).not.toBe(firstEnv.OPENCODE_CONFIG);
    expect(await messageRequestCount(directory)).toBe(2);
  }, 15_000);

  it("accepts an export document after a standalone CLI warning line", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-export-prefix-");
    const command = await makeOpenCodeFixture(directory, {
      exportPrefix: 'CLI warning {"detail":"not a session"}\n',
    });
    const result = await runFixtureChat(directory, command);
    expect(result.summary).toBe("native answer");
  });

  it("reads all export output before parsing and rejects oversized exports", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-export-large-");
    const command = await makeOpenCodeFixture(directory, { exportPadBytes: 2_000_000 });
    expect((await runFixtureChat(directory, command)).summary).toBe("native answer");

    const oversizedDirectory = await makeFixtureDirectory("rudder-opencode-export-limit-");
    const oversizedCommand = await makeOpenCodeFixture(oversizedDirectory, { exportPadBytes: 32_000_001 });
    await expect(runFixtureChat(oversizedDirectory, oversizedCommand)).rejects.toMatchObject({
      message: "OpenCode export exceeded the native size limit.",
    });
  });

  it("recovers a 1.18-style truncated CLI export from the authenticated session API", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-export-truncated-");
    const command = await makeOpenCodeFixture(directory, {
      exportOverride: {
        info: { id: "oc-session-1", padding: "x".repeat(100_000) },
        messages: [],
      },
      truncateExportBytes: 65_536,
    });
    const result = await runFixtureChat(directory, command);
    expect(result.summary).toBe("native answer");
    expect(result.sessionId).toBe("oc-session-1");
    const requests = await fixtureRequests(directory);
    expect(requests.some((request) => request.method === "GET" && request.url?.startsWith("/session/oc-session-1/message?"))).toBe(true);
    expect(requests.every((request) => request.authorized === true)).toBe(true);
  });

  it("rejects an invalid message list after a truncated export", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-export-invalid-api-");
    const command = await makeOpenCodeFixture(directory, {
      exportOverride: { info: { id: "oc-session-1", padding: "x".repeat(100_000) }, messages: [] },
      truncateExportBytes: 65_536,
      serverMessagesOverride: { error: "private-response" },
    });
    await expect(runFixtureChat(directory, command)).rejects.toMatchObject({
      message: "OpenCode returned no session messages.",
    });
  });

  it("does not attach to an unrelated loopback server stored in session metadata", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-server-isolation-");
    const command = await makeOpenCodeFixture(directory);
    let foreignRequests = 0;
    const foreignServer = createServer((_request, response) => {
      foreignRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "foreign-server" }));
    });
    await new Promise<void>((resolve, reject) => {
      foreignServer.once("error", reject);
      foreignServer.listen(0, "127.0.0.1", resolve);
    });
    const address = foreignServer.address();
    if (!address || typeof address === "string") throw new Error("Foreign fixture server did not bind a TCP port.");
    try {
      const persistedSession = sessionFor(directory, command);
      const result = await runFixtureChat(directory, command, {
        session: {
          ...persistedSession.sessionParams,
          serverUrl: `http://127.0.0.1:${address.port}`,
          exportEnv: {
            HOME: directory,
            OPENCODE_CONFIG: path.join(directory, "opencode.json"),
          },
        },
      });
      expect(result.exitCode).toBe(0);
      expect(foreignRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => foreignServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("reconnects the native event stream without resubmitting the prompt", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-event-reconnect-");
    const command = await makeOpenCodeFixture(directory, {
      disconnectAfterEventCount: 1,
      messageResponseDelayMs: 100,
    });
    const result = await runFixtureChat(directory, command);
    const requests = await fixtureRequests(directory);
    const eventRequests = requests.filter((request) => request.method === "GET" && request.url?.startsWith("/event"));
    expect(result.exitCode).toBe(0);
    expect(eventRequests.length).toBeGreaterThanOrEqual(2);
    expect(eventRequests[1]?.lastEventId).toBe("fixture-event");
    expect(await messageRequestCount(directory)).toBe(1);
    expect(requests.every((request) => request.authorized === true)).toBe(true);
  });

  it("waits for transport profile persistence before creating a provider session", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-profile-fence-");
    const command = await makeOpenCodeFixture(directory);
    await expect(runFixtureChat(directory, command, {
      onNativeTransportProfile: async () => {
        throw new Error("transport profile persistence failed");
      },
    })).rejects.toThrow("transport profile persistence failed");
    expect(await messageRequestCount(directory)).toBe(0);
    const requests = await fixtureRequests(directory);
    expect(requests.some((request) => request.method === "POST" && request.url === "/session")).toBe(false);
  });

  it("round-trips duplicate permission events through one approval and one provider once reply", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-permission-");
    const command = await makeOpenCodeFixture(directory, {
      streamEvents: [
        {
          type: "permission.asked",
          properties: {
            sessionID: "oc-session-1",
            id: "permission-1",
            permission: "file.read",
            patterns: ["src/**"],
          },
        },
        {
          type: "permission.asked",
          properties: {
            sessionID: "oc-session-1",
            id: "permission-1",
            permission: "file.read",
            patterns: ["src/**"],
          },
        },
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "provider-assistant-1", partID: "provider-part-1", field: "text", delta: "native answer" } },
        { type: "session.idle", properties: { sessionID: "oc-session-1" } },
      ],
    });
    const approvals: Array<{ payload?: Record<string, unknown> }> = [];
    const waits: string[] = [];
    const result = await runFixtureChat(directory, command, {
      runId: "run-permission-1",
      requestApproval: async (request) => {
        approvals.push(request);
        return { id: "approval-permission-1", status: "pending" };
      },
      waitForApproval: async (approvalId) => {
        waits.push(approvalId);
        return { id: approvalId, status: "approved" };
      },
    });

    expect(result.summary).toBe("native answer");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.payload).toMatchObject({
      provider: "opencode",
      interactionKind: "permission",
      requestId: "permission-1",
      runId: "run-permission-1",
      permission: "file.read",
    });
    expect(waits).toEqual(["approval-permission-1"]);
    const requests = await fixtureRequests(directory);
    const replies = requests.filter((request) => request.method === "POST" && request.url?.includes("/permission/permission-1/reply"));
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toEqual({ reply: "once" });
    expect(requests.filter((request) => request.method === "POST" && request.url?.includes("/permission/permission-1/"))).toHaveLength(1);
  });

  it("pauses inactivity while a provider permission is awaiting approval, within the hard cap", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-approval-idle-");
    const command = await makeOpenCodeFixture(directory, {
      streamEvents: [
        { type: "permission.asked", properties: { sessionID: "oc-session-1", id: "permission-idle", permission: "file.read" } },
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "assistant", delta: "done" } },
        { type: "session.idle", properties: { sessionID: "oc-session-1" } },
      ],
    });
    const started = Date.now();
    const result = await runFixtureChat(directory, command, {
      timeoutSec: 4, maxTurnSec: 4, idleTimeoutSec: 1,
      requestApproval: async () => ({ id: "approval-idle", status: "pending" }),
      waitForApproval: async (id) => {
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        return { id, status: "approved" };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeGreaterThan(1_200);
  }, 10_000);

  it("maps typed question inputResponse option IDs and freeform text to OpenCode labels", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-question-");
    const command = await makeOpenCodeFixture(directory, {
      streamEvents: [
        {
          type: "question.asked",
          properties: {
            sessionID: "oc-session-1",
            id: "question-1",
            questions: [{
              header: "Scope",
              question: "Which scopes should be enabled?",
              multiple: true,
              custom: true,
              options: [{ label: "Narrow", description: "Only the current package" }, { label: "Broad" }],
            }],
          },
        },
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "provider-assistant-1", partID: "provider-part-1", field: "text", delta: "native answer" } },
        { type: "session.idle", properties: { sessionID: "oc-session-1" } },
      ],
    });
    const approvals: Array<{ inputRequest?: { questions?: unknown[] }; payload?: Record<string, unknown> }> = [];
    const result = await runFixtureChat(directory, command, {
      requestApproval: async (request) => {
        approvals.push(request);
        return { id: "approval-question-1", status: "pending" };
      },
      waitForApproval: async (approvalId) => ({
        id: approvalId,
        status: "approved",
        inputResponse: {
          answers: [{ questionId: "q1", optionIds: ["o1", "o2"], freeformText: "extra" }],
        },
      }),
    });

    expect(result.summary).toBe("native answer");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.inputRequest).toMatchObject({
      questions: [{
        id: "q1",
        header: "Scope",
        question: "Which scopes should be enabled?",
        selectionMode: "multiple",
        allowFreeform: true,
        options: [{ id: "o1", label: "Narrow" }, { id: "o2", label: "Broad" }],
      }],
    });
    expect(approvals[0]?.payload).toMatchObject({
      interactionKind: "question",
      requestId: "question-1",
      questionRequestId: "question-1",
    });
    const requests = await fixtureRequests(directory);
    const replies = requests.filter((request) => request.method === "POST" && request.url?.includes("/question/question-1/reply"));
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toEqual({ answers: [["Narrow", "Broad", "extra"]] });
    expect(requests.filter((request) => request.method === "POST" && request.url?.includes("/question/question-1/reject"))).toHaveLength(0);
  });

  it("rejects a permission after the control attempt becomes stale even when approval returns approved", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-stale-approval-");
    const command = await makeOpenCodeFixture(directory, {
      streamEvents: [
        {
          type: "permission.asked",
          properties: { sessionID: "oc-session-1", id: "permission-stale", permission: "file.read" },
        },
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "provider-assistant-1", partID: "provider-part-1", field: "text", delta: "native answer" } },
        { type: "session.idle", properties: { sessionID: "oc-session-1" } },
      ],
    });
    let current = true;
    const approvals: string[] = [];
    const execution = runFixtureChat(directory, command, {
      controlAttempt: {
        attemptEpoch: 7,
        ownerToken: "owner-stale",
        register: async () => ({ isCurrent: () => current, release: async () => {} }),
        complete: async () => {},
      },
      requestApproval: async () => {
        approvals.push("requested");
        return { id: "approval-stale", status: "pending" };
      },
      waitForApproval: async (approvalId) => {
        current = false;
        return { id: approvalId, status: "approved" };
      },
    });

    await expect(execution).rejects.toThrow(/no longer current|cancelled/u);
    expect(approvals).toEqual(["requested"]);
    const requests = await fixtureRequests(directory);
    const replies = requests.filter((request) => request.method === "POST" && request.url?.includes("/permission/permission-stale/reply"));
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toMatchObject({ reply: "reject" });
    expect(requests.filter((request) => request.method === "POST" && request.url?.includes("/permission/permission-stale/reply") && (request.body as { reply?: string })?.reply === "once")).toHaveLength(0);
    expect(await messageRequestCount(directory)).toBe(1);
  });

  it("interrupts a registered native control handle through the provider abort endpoint", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-abort-");
    const command = await makeOpenCodeFixture(directory, {
      waitForAbort: true,
      streamEvents: [{ type: "session.next.prompted", properties: { sessionID: "oc-session-1", prompt: { text: "boundary test prompt" } } }],
    });
    let handle: Parameters<NonNullable<NativeChatInput["controlAttempt"]>["register"]>[0] | null = null;
    let released = false;
    const execution = runFixtureChat(directory, command, {
      controlAttempt: {
        attemptEpoch: 9,
        ownerToken: "owner-abort",
        register: async (value) => {
          handle = value;
          return { isCurrent: () => true, release: async () => { released = true; } };
        },
        complete: async () => {},
      },
    });
    const executionOutcome = execution.then(
      () => null,
      (error: unknown) => error,
    );

    await waitForValue(() => handle);
    await waitForMessageRequest(directory);
    await expect(handle!.interrupt("operator_stop")).resolves.toBe("acknowledged");
    const executionError = await executionOutcome;
    expect(executionError).toBeInstanceOf(Error);
    expect((executionError as Error).message).toMatch(/interrupted|cancelled/u);
    const requests = await fixtureRequests(directory);
    expect(requests.filter((request) => request.method === "POST" && request.url?.includes("/session/oc-session-1/prompt_async"))).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST" && request.url?.includes("/session/oc-session-1/abort"))).toHaveLength(1);
    expect(released).toBe(true);
  });

  it.each(["stall", "reject", "false", "no-content"] as const)("reports a %s provider abort as unverified through the native control handle", async (abortMode) => {
    const directory = await makeFixtureDirectory(`rudder-opencode-control-${abortMode}-abort-`);
    const command = await makeOpenCodeFixture(directory, {
      waitForAbort: true,
      abortMode,
      streamEvents: [{ type: "session.next.prompted", properties: { sessionID: "oc-session-1", prompt: { text: "boundary test prompt" } } }],
    });
    let handle: Parameters<NonNullable<NativeChatInput["controlAttempt"]>["register"]>[0] | null = null;
    let released = false;
    const execution = runFixtureChat(directory, command, {
      controlAttempt: {
        attemptEpoch: 10,
        ownerToken: `owner-${abortMode}-abort`,
        register: async (value) => {
          handle = value;
          return { isCurrent: () => true, release: async () => { released = true; } };
        },
        complete: async () => {},
      },
    });
    const executionOutcome = execution.then(
      () => null,
      (error: unknown) => error,
    );

    await waitForValue(() => handle, 10_000);
    await waitForMessageRequest(directory);
    let interruptsSettled = false;
    const interruptions = Promise.all([
      handle!.interrupt("operator_stop"),
      handle!.interrupt("operator_stop"),
    ]).then((results) => {
      interruptsSettled = true;
      return results;
    });
    if (abortMode === "stall") {
      await waitForValue(() => {
        try {
          return fsSync.readFileSync(path.join(directory, "requests.jsonl"), "utf8").includes("/session/oc-session-1/abort")
            ? true
            : null;
        } catch {
          return null;
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(interruptsSettled).toBe(false);
    }
    await expect(interruptions).resolves.toEqual(["unverified", "unverified"]);
    const executionError = await executionOutcome as {
      sessionContext?: { submissionPhase: string; providerAbortAcknowledged?: boolean };
    };
    expect(executionError).toBeInstanceOf(Error);
    expect(executionError.sessionContext).toMatchObject({ submissionPhase: "accepted", providerAbortAcknowledged: false });
    const requests = await fixtureRequests(directory);
    expect(requests.filter((request) => request.method === "POST" && request.url?.includes("/session/oc-session-1/abort"))).toHaveLength(1);
    expect(released).toBe(true);
  }, 10_000);

  it("reads an interrupted R1 from observed SSE IDs without including a later R2", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-partial-r1-r2-");
    const command = await makeOpenCodeFixture(directory, {
      waitForAbort: true,
      persistPartialOnAbort: true,
      partialAssistantText: "R1 partial answer",
      sourceExport: { info: { id: "oc-session-1" }, messages: [] },
      laterMessages: [
        {
          info: { id: "provider-user-r2", role: "user", parentID: "$INTERRUPTED_ASSISTANT", sessionID: "oc-session-1" },
          parts: [{ type: "text", text: "R2 input" }],
        },
        {
          info: { id: "provider-assistant-r2", role: "assistant", parentID: "provider-user-r2", sessionID: "oc-session-1", finish: "stop" },
          parts: [{ type: "text", text: "R2 answer" }],
        },
      ],
      streamEvents: [
        { type: "session.next.prompted", properties: { sessionID: "oc-session-1", prompt: { text: "boundary test prompt" } } },
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "provider-assistant-r1", partID: "provider-part-r1", field: "text", delta: "R1 partial answer" } },
      ],
    });
    let handle: Parameters<NonNullable<NativeChatInput["controlAttempt"]>["register"]>[0] | null = null;
    let observedDelta!: () => void;
    const deltaReceived = new Promise<void>((resolve) => { observedDelta = resolve; });
    const execution = runFixtureChat(directory, command, {
      controlAttempt: {
        attemptEpoch: 10,
        ownerToken: "owner-partial-r1",
        register: async (value) => {
          handle = value;
          return { isCurrent: () => true, release: async () => {} };
        },
        complete: async () => {},
      },
      onLog: async (_stream, chunk) => {
        if (chunk.includes("OpenCode native stream delta")) observedDelta();
      },
    });
    const executionOutcome = execution.then(
      () => null,
      (error: unknown) => error,
    );

    await waitForValue(() => handle);
    await waitForMessageRequest(directory);
    await deltaReceived;
    await expect(handle!.interrupt("operator_stop")).resolves.toBe("acknowledged");
    const executionError = await executionOutcome as {
      sessionContext?: {
        sessionId: string;
        userMessageId?: string;
        observedAssistantMessageIds?: string[];
      };
    };
    expect(executionError.sessionContext).toMatchObject({
      sessionId: "oc-session-1",
      userMessageId: expect.stringMatching(/^msg/u),
      observedAssistantMessageIds: [expect.stringMatching(/^assistant-msg/u)],
    });

    const userMessageId = executionError.sessionContext!.userMessageId!;
    const observedAssistantMessageIds = executionError.sessionContext!.observedAssistantMessageIds!;
    await disposeOpenCodeNativeServersForTests();
    const transcript = await readOpenCodeNativeTranscript({
      runtimeType: "opencode_local",
      session: sessionFor(directory, command),
      selector: {
        kind: "opencode_input",
        sessionId: "oc-session-1",
        userMessageId,
        terminalMessageIds: [],
        observedAssistantMessageIds,
        completeness: "partial",
      },
      binding: { hostId: "local", profileId: "opencode-profile" },
    });
    expect(transcript).toMatchObject({ availability: "available", completeness: "partial" });
    expect(transcript.items.map((item) => item.sourceEntryId)).toEqual([userMessageId, ...observedAssistantMessageIds]);
    expect(transcript.items.map((item) => item.text).filter(Boolean)).toEqual([
      "boundary test prompt",
      "R1 partial answer",
    ]);
    expect(transcript.items.some((item) => item.sourceEntryId === "provider-user-r2" || item.sourceEntryId === "provider-assistant-r2")).toBe(false);
  });

  it("does not attest a foreign same-session delta as the stopped Run's assistant", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-foreign-delta-");
    const command = await makeOpenCodeFixture(directory, {
      waitForAbort: true,
      persistPartialOnAbort: true,
      sourceExport: { info: { id: "oc-session-1" }, messages: [
        { info: { id: "foreign-user", role: "user", sessionID: "oc-session-1" }, parts: [] },
        { info: { id: "foreign-assistant", role: "assistant", parentID: "foreign-user", sessionID: "oc-session-1" }, parts: [{ type: "text", text: "foreign" }] },
      ] },
      streamEvents: [
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "$FOREIGN_ASSISTANT", delta: "foreign" } },
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "current", delta: "ours" } },
      ],
    });
    const abort = new AbortController();
    let observed!: () => void;
    const deltas = new Promise<void>((resolve) => { observed = resolve; });
    let count = 0;
    const result = runFixtureChat(directory, command, {
      signal: abort.signal,
      onLog: async (_stream, chunk) => { if (chunk.includes("OpenCode native stream delta") && ++count === 2) observed(); },
    }).then(() => null, (error: unknown) => error);
    await deltas;
    abort.abort(new Error("Chat Stop"));
    const failure = await result as { sessionContext?: { observedAssistantMessageIds?: string[] } };
    expect(failure.sessionContext?.observedAssistantMessageIds).toEqual([expect.stringMatching(/^assistant-msg/u)]);
    expect(failure.sessionContext?.observedAssistantMessageIds).not.toContain("foreign-assistant");
  });

  it("bounds an accepted 204 with connected but silent SSE by timeoutSec", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-silent-204-");
    const command = await makeOpenCodeFixture(directory, { waitForAbort: true, streamEvents: [] });
    const started = Date.now();
    await expect(runFixtureChat(directory, command, { timeoutSec: 1 })).rejects.toMatchObject({
      sessionContext: { submissionPhase: "accepted" },
      message: expect.stringContaining("timed out after 1s"),
    });
    expect(Date.now() - started).toBeLessThan(4_000);
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { url: string });
    expect(requests.some((request) => request.url.includes("/abort"))).toBe(true);
  });

  it("keeps submission indeterminate when timeout and abort precede a delayed 204", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-late-204-");
    const command = await makeOpenCodeFixture(directory, {
      waitForAbort: true, streamEvents: [], promptResponseDelayMs: 1_500,
    });
    await expect(runFixtureChat(directory, command, { timeoutSec: 1 }))
      .rejects.toMatchObject({
        timedOut: true,
        sessionContext: { submissionPhase: "indeterminate", providerAbortAcknowledged: true, userMessageId: expect.stringMatching(/^msg/u) },
      });
    expect((await fixtureRequests(directory)).filter((request) => request.url?.includes("/prompt_async"))).toHaveLength(1);
  }, 10_000);

  it.each(["stall", "reject", "false", "no-content"] as const)("reports an unconfirmed %s abort without waiting for the normal request deadline", async (abortMode) => {
    const directory = await makeFixtureDirectory(`rudder-opencode-${abortMode}-abort-`);
    const command = await makeOpenCodeFixture(directory, { waitForAbort: true, streamEvents: [], abortMode });
    const started = Date.now();
    const result = await executeOpenCodeAdapter({
      runId: `run-${abortMode}-abort`, agent: { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: directory, model: "provider/model", promptTemplate: "{{context.chatPrompt}}",
        timeoutSec: 1, env: { HOME: directory } },
      context: { chatMode: true, chatPrompt: "silent turn" },
      authToken: "fixture-token", onLog: async () => {},
    });
    expect(result).toMatchObject({
      exitCode: 1, timedOut: true, errorCode: "opencode_native_timed_out",
      errorMessage: expect.stringContaining("Provider abort request was not acknowledged"),
      submissionPhase: "accepted", resultJson: { providerAbortAcknowledged: false },
      nativeWriterQuiescence: { status: "unconfirmed" },
    });
    expect(Date.now() - started).toBeLessThan(7_000);
    expect((await fixtureRequests(directory)).filter((request) => request.method === "POST" && request.url?.includes("/abort"))).toHaveLength(1);
  }, 10_000);

  it("does not treat a bare abort acknowledgement as writer quiescence when partial export stalls", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-stalled-partial-export-");
    const command = await makeOpenCodeFixture(directory, {
      waitForAbort: true, persistPartialOnAbort: true, exportDelayMs: 10_000,
      streamEvents: [{ type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "assistant", delta: "partial" } }],
    });
    const started = Date.now();
    const result = await executeOpenCodeAdapter({
      runId: "run-stalled-export", agent: { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: directory, model: "provider/model", promptTemplate: "{{context.chatPrompt}}", timeoutSec: 1, env: { HOME: directory } },
      context: { chatMode: true, chatPrompt: "partial turn" }, authToken: "fixture-token", onLog: async () => {},
    });
    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: true,
      errorCode: "opencode_native_timed_out",
      resultJson: { providerAbortAcknowledged: true },
      nativeWriterQuiescence: {
        status: "unconfirmed",
        reason: "OpenCode acknowledged the session abort request without a turn-scoped terminal event.",
      },
    });
    expect(hasConfirmedNativeWriterQuiescence(result)).toBe(false);
    expect(result.resultJson).not.toHaveProperty("transcriptBoundary");
    expect(Date.now() - started).toBeLessThan(7_000);
  }, 10_000);

  it("uses an inactivity window for the default chat timeout while active native output continues", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-active-chat-deadline-");
    const command = await makeOpenCodeFixture(directory, {
      streamEventDelayMs: 400,
      streamEvents: [
        { type: "session.next.prompted", properties: { sessionID: "oc-session-1" } },
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "assistant", delta: "part 1" } },
        { type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "assistant", delta: "part 2" } },
        { type: "session.idle", properties: { sessionID: "oc-session-1" } },
      ],
    });
    const started = Date.now();
    const result = await executeOpenCodeAdapter({
      runId: "run-active-chat", agent: { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: directory, model: "provider/model", promptTemplate: "{{context.chatPrompt}}",
        nativeIdleTimeoutSec: 1, nativeMaxTurnSec: 5, env: { HOME: directory } },
      context: { chatMode: true, chatPrompt: "long active turn" },
      authToken: "fixture-token", onLog: async () => {},
    });
    expect(result).toMatchObject({ exitCode: 0, summary: "native answer" });
    expect(Date.now() - started).toBeGreaterThan(1_300);
    expect(await messageRequestCount(directory)).toBe(1);
  }, 10_000);

  it("aborts a silent accepted chat turn on inactivity before the maximum turn duration", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-idle-chat-deadline-");
    const command = await makeOpenCodeFixture(directory, { waitForAbort: true, streamEvents: [] });
    const result = await executeOpenCodeAdapter({
      runId: "run-idle-chat", agent: { id: "agent-1", orgId: "organization-1", name: "OpenCode Agent", agentRuntimeType: "opencode_local", agentRuntimeConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: directory, model: "provider/model", promptTemplate: "{{context.chatPrompt}}",
        nativeIdleTimeoutSec: 1, nativeMaxTurnSec: 5, env: { HOME: directory } },
      context: { chatMode: true, chatPrompt: "silent turn" },
      authToken: "fixture-token", onLog: async () => {},
    });
    expect(result).toMatchObject({ exitCode: 1, errorMessage: expect.stringContaining("inactive for 1s"), submissionPhase: "accepted" });
    expect(result).toMatchObject({
      timedOut: true,
      errorCode: "opencode_native_timed_out",
      resultJson: { providerAbortAcknowledged: true },
      nativeWriterQuiescence: { status: "unconfirmed" },
    });
    const requests = await fixtureRequests(directory);
    expect(requests.some((request) => request.method === "POST" && request.url?.includes("/abort"))).toBe(true);
  }, 10_000);

  it("keeps the explicit maximum turn timeout despite continuing native output", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-hard-chat-deadline-");
    const command = await makeOpenCodeFixture(directory, {
      waitForAbort: true, streamEventDelayMs: 200,
      streamEvents: Array.from({ length: 10 }, () => ({
        type: "message.part.delta", properties: { sessionID: "oc-session-1", messageID: "assistant", delta: "progress" },
      })),
    });
    await expect(runFixtureChat(directory, command, { timeoutSec: 1, maxTurnSec: 1, idleTimeoutSec: 2 }))
      .rejects.toMatchObject({ message: expect.stringContaining("timed out after 1s"), timedOut: true, sessionContext: { submissionPhase: "accepted", providerAbortAcknowledged: true } });
    const requests = await fixtureRequests(directory);
    expect(requests.some((request) => request.method === "POST" && request.url?.includes("/abort"))).toBe(true);
  }, 10_000);

  it("treats 204 as accepted and waits for the matching native terminal message", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-204-");
    const command = await makeOpenCodeFixture(directory, { messageResponseDelayMs: 120 });
    let settled = false;
    const execution = runFixtureChat(directory, command).then((result) => {
      settled = true;
      return result;
    });
    await waitForMessageRequest(directory);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(await messageRequestCount(directory)).toBe(1);
    await expect(execution).resolves.toMatchObject({ exitCode: 0, summary: "native answer" });
    expect(await messageRequestCount(directory)).toBe(1);
  });

  it("submits attachments as native file parts", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-media-");
    const command = await makeOpenCodeFixture(directory);
    await runFixtureChat(directory, command, {
      media: [{
        source: "chat_attachment",
        attachmentId: "attachment-1",
        assetId: "asset-1",
        name: "diagram",
        originalFilename: "diagram.png",
        contentType: "image/png",
        byteSize: 12,
        localPath: path.join(directory, "diagram.png"),
      }],
    });
    const request = (await fixtureRequests(directory)).find((entry) => entry.method === "POST" && entry.url?.includes("/prompt_async"));
    expect(request?.body).toMatchObject({
      parts: [
        { type: "text", text: "boundary test prompt" },
        {
          type: "file",
          mime: "image/png",
          filename: "diagram.png",
          url: new URL(`file://${path.resolve(directory, "diagram.png")}`).toString(),
        },
      ],
    });
  });

  it("rejects an id-bearing partial or reasoning response without terminal metadata", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-partial-");
    const command = await makeOpenCodeFixture(directory, {
      messageResponse: {
        body: {
          info: {
            id: "provider-assistant-partial",
            role: "assistant",
            parentID: "provider-user-1",
            sessionID: "oc-session-1",
            time: { created: 2 },
          },
          parts: [{ type: "reasoning", text: "still thinking" }],
        },
      },
    });
    await expect(runFixtureChat(directory, command)).rejects.toMatchObject({
      status: "unknown",
      message: expect.stringContaining("terminal finish"),
    });
    expect(await messageRequestCount(directory)).toBe(1);
  });

  it("rejects a terminal reasoning-only response instead of persisting it as final text", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-native-reasoning-");
    const command = await makeOpenCodeFixture(directory, {
      messageResponse: {
        body: {
          info: {
            id: "provider-assistant-reasoning",
            role: "assistant",
            parentID: "provider-user-1",
            sessionID: "oc-session-1",
            time: { created: 2, completed: 3 },
            finish: "stop",
          },
          parts: [{ type: "reasoning", text: "internal reasoning only" }],
        },
      },
    });
    await expect(runFixtureChat(directory, command)).rejects.toMatchObject({
      status: "unknown",
      message: expect.stringContaining("no final text part"),
    });
    expect(await messageRequestCount(directory)).toBe(1);
  });

  it("surfaces provider errors and cancellations before the id/terminal success path", async () => {
    const cases = [
      {
        prefix: "provider-error",
        body: {
          info: {
            id: "provider-assistant-error",
            role: "assistant",
            parentID: "provider-user-1",
            sessionID: "oc-session-1",
            error: { name: "APIError", message: "provider returned HTTP 400" },
          },
          parts: [],
        },
        expected: ["failed", "APIError", "provider returned HTTP 400"],
        expectedSource: "adapter",
      },
      {
        prefix: "cancelled",
        body: {
          info: {
            id: "provider-assistant-cancelled",
            role: "assistant",
            parentID: "provider-user-1",
            sessionID: "oc-session-1",
            error: { name: "MessageAbortedError", message: "request aborted" },
          },
          parts: [],
        },
        expected: ["cancelled", "MessageAbortedError", "request aborted"],
        expectedSource: "adapter",
      },
      {
        prefix: "exported-provider-error",
        body: {
          info: {
            id: "provider-assistant-error",
            role: "assistant",
            parentID: "provider-user-1",
            sessionID: "oc-session-1",
            error: {
              name: "APIError",
              message: "OpenCode 1.18.0 or newer is required for the Console free tier",
              data: {
                statusCode: 426,
                responseBody: JSON.stringify({ error: { type: "UpgradeRequired", detail: "response-body-secret" } }),
                responseHeaders: { authorization: "header-secret" },
              },
            },
          },
          parts: [],
        },
        expected: ["failed", "APIError HTTP 426 (UpgradeRequired)", "OpenCode 1.18.0 or newer"],
        expectedSource: "provider",
      },
    ];
    for (const testCase of cases) {
      const directory = await makeFixtureDirectory(`rudder-opencode-native-${testCase.prefix}-`);
      const command = await makeOpenCodeFixture(directory, { messageResponse: { body: testCase.body } });
      const error = await runFixtureChat(directory, command).then(
        () => null,
        (value: unknown) => value as { status?: string; source?: string; message?: string },
      );
      expect(error).toMatchObject({ status: "unknown", source: testCase.expectedSource });
      for (const expected of testCase.expected) expect(error?.message).toContain(expected);
      expect(error?.message).not.toMatch(/header-secret|response-body-secret|\[object Object\]/u);
      expect(await messageRequestCount(directory)).toBe(1);
    }
  });

  it("resumes persisted provider session params after the managed server is restarted", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-resume-");
    const command = await makeOpenCodeFixture(directory);
    const first = await executeOpenCodeNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory, OPENCODE_CONFIG: path.join(directory, "opencode.json") },
      prompt: "first native input",
      model: "provider/model",
      variant: "",
      session: {},
      binding: { hostId: "local", profileId: "opencode-profile" },
      timeoutSec: 10,
      onLog: async () => {},
    });
    const persisted = first.sessionParams as Record<string, unknown>;
    await disposeOpenCodeNativeServersForTests();
    const second = await executeOpenCodeNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory, OPENCODE_CONFIG: path.join(directory, "opencode.json") },
      prompt: "resumed native input",
      model: "provider/model",
      variant: "",
      session: persisted,
      binding: { hostId: "local", profileId: "opencode-profile" },
      timeoutSec: 10,
      onLog: async () => {},
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.resultJson).toMatchObject({
      transport: "opencode_server",
      providerSessionId: first.sessionId,
    });
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; url: string });
    expect(requests.filter((request) => request.method === "POST" && (request.url === "/session" || request.url.startsWith("/session?")))).toHaveLength(1);
    expect(requests.filter((request) => request.method === "GET" && request.url?.includes("/session/oc-session-1"))).toHaveLength(1);
  });

  it("rotates only the verified managed Run config when resuming a bound session", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-rotate-config-");
    const command = await makeOpenCodeFixture(directory);
    const firstEnv = managedFixtureEnv(directory, "run-r1");
    const secondEnv = managedFixtureEnv(directory, "run-r2");
    const binding = {
      id: "binding-a",
      orgId: "org-a",
      hostId: "local",
      profileId: "opencode-profile",
      workspaceBindingId: "workspace-binding-a",
    };
    const workspace = { workspaceId: "workspace-a", workspaceBindingId: binding.workspaceBindingId };
    await writeFixtureConfig(firstEnv.OPENCODE_CONFIG);
    const first = await runFixtureChat(directory, command, {
      runId: "run-r1",
      verifiedConfigPath: firstEnv.OPENCODE_CONFIG,
      env: firstEnv,
      binding,
      workspace,
    });
    const persisted = first.sessionParams as Record<string, unknown>;
    await fs.rm(firstEnv.OPENCODE_CONFIG);
    await fs.mkdir(path.dirname(secondEnv.OPENCODE_CONFIG), { recursive: true });
    const resume = (overrides: Partial<NativeChatInput> = {}) => runFixtureChat(directory, command, {
      runId: "run-r2",
      verifiedConfigPath: secondEnv.OPENCODE_CONFIG,
      env: secondEnv,
      session: persisted,
      binding,
      workspace,
      ...overrides,
    });

    await expect(resume()).rejects.toMatchObject({ status: "unsupported", message: expect.stringContaining("current managed Run config") });
    const symlinkTarget = path.join(directory, "untrusted-config.json");
    await fs.writeFile(symlinkTarget, "{}", "utf8");
    await fs.symlink(symlinkTarget, secondEnv.OPENCODE_CONFIG);
    await expect(resume()).rejects.toMatchObject({ status: "unsupported", message: expect.stringContaining("current managed Run config") });
    await fs.rm(secondEnv.OPENCODE_CONFIG);
    await writeFixtureConfig(secondEnv.OPENCODE_CONFIG);

    const invalidInputs: Partial<NativeChatInput>[] = [
      { verifiedConfigPath: null },
      { runId: "another-run" },
      { env: { ...secondEnv, RUDDER_OPERATOR_HOME: "/other/operator" } },
      { env: { ...secondEnv, XDG_DATA_HOME: "/other/organization/.local/share" } },
      { env: { ...secondEnv, OPENCODE_CONFIG: symlinkTarget }, verifiedConfigPath: symlinkTarget },
      { session: { ...persisted, exportEnv: { ...firstEnv, OPENCODE_CONFIG: symlinkTarget } } },
      { binding: { ...binding, orgId: "org-b" } },
      { binding: { ...binding, profileId: "another-profile" } },
      { workspace: { ...workspace, workspaceId: "another-workspace" } },
      { workspace: { ...workspace, workspaceBindingId: "another-workspace-binding" } },
    ];
    for (const overrides of invalidInputs) {
      await expect(resume(overrides)).rejects.toMatchObject({ status: "unsupported" });
    }
    expect(await messageRequestCount(directory)).toBe(1);

    const second = await resume();
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sessionParams).toMatchObject({ exportEnv: secondEnv });
    const servers = (await fixtureProcessEnvs(directory)).filter((entry) => entry.action === "serve");
    expect(servers).toHaveLength(1);
    expect(servers[0]?.config).toContain("native-server-config");
    expect(await fs.readFile(servers[0]!.config!, "utf8")).toBe("{}");
    expect(await messageRequestCount(directory)).toBe(2);
  });

  it("retires an idle server and its persistent config when the verified profile config changes", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-managed-server-lifecycle-");
    const command = await makeOpenCodeFixture(directory);
    const binding = { id: "binding-a", orgId: "org-a", hostId: "local", profileId: "profile-a" };
    const firstEnv = managedFixtureEnv(directory, "run-r1");
    const secondEnv = managedFixtureEnv(directory, "run-r2");
    await writeFixtureConfig(firstEnv.OPENCODE_CONFIG);
    const first = await runFixtureChat(directory, command, {
      runId: "run-r1", verifiedConfigPath: firstEnv.OPENCODE_CONFIG, env: firstEnv, binding,
    });
    const firstServerConfig = (await fixtureProcessEnvs(directory)).find((entry) => entry.action === "serve")!.config!;
    await fs.rm(firstEnv.OPENCODE_CONFIG);
    await fs.mkdir(path.dirname(secondEnv.OPENCODE_CONFIG), { recursive: true });
    await fs.writeFile(secondEnv.OPENCODE_CONFIG, '{"new":true}', "utf8");
    await runFixtureChat(directory, command, {
      runId: "run-r2", verifiedConfigPath: secondEnv.OPENCODE_CONFIG, env: secondEnv,
      session: first.sessionParams as Record<string, unknown>, binding,
    });
    const servers = (await fixtureProcessEnvs(directory)).filter((entry) => entry.action === "serve");
    expect(servers).toHaveLength(2);
    expect(servers[1]?.config).not.toBe(firstServerConfig);
    await expect(fs.stat(firstServerConfig)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(servers[1]!.config!, "utf8")).toBe('{"new":true}');
    await disposeOpenCodeNativeServersForTests();
    await expect(fs.stat(servers[1]!.config!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares one managed server across concurrent acquisitions of the same verified profile", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-concurrent-server-");
    const command = await makeOpenCodeFixture(directory);
    const env = managedFixtureEnv(directory, "run-r1");
    await writeFixtureConfig(env.OPENCODE_CONFIG);
    const input = { command, cwd: directory, env, binding: { hostId: "local", profileId: "profile-a", orgId: "org-a" } };
    const leases = await Promise.all([ensureManagedOpenCodeServer(input), ensureManagedOpenCodeServer(input)]);
    expect(leases[0]?.url).toBe(leases[1]?.url);
    expect((await fixtureProcessEnvs(directory)).filter((entry) => entry.action === "serve")).toHaveLength(1);
    for (const lease of leases) lease.release();
  });

  it("reuses across Run identity but rotates on an inherited provider environment change without exposing its value in the key", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-server-env-rotation-");
    const command = await makeOpenCodeFixture(directory);
    const firstEnv = { ...managedFixtureEnv(directory, "run-r1"), RUDDER_RUN_ID: "run-r1", FIXTURE_PROVIDER_TOKEN: "provider-secret-one" };
    const secondEnv = { ...managedFixtureEnv(directory, "run-r2"), RUDDER_RUN_ID: "run-r2", FIXTURE_PROVIDER_TOKEN: "provider-secret-one" };
    const changedEnv = { ...secondEnv, FIXTURE_PROVIDER_TOKEN: "provider-secret-two" };
    await writeFixtureConfig(firstEnv.OPENCODE_CONFIG);
    await writeFixtureConfig(secondEnv.OPENCODE_CONFIG);
    const binding = { hostId: "local", profileId: "profile-a", orgId: "org-a" };
    const acquire = (env: typeof firstEnv) => ensureManagedOpenCodeServer({ command, cwd: directory, env, binding });
    const first = await acquire(firstEnv);
    first.release();
    const reused = await acquire(secondEnv);
    expect(reused.url).toBe(first.url);
    reused.release();
    const previousConfig = (await fixtureProcessEnvs(directory)).find((entry) => entry.action === "serve")!.config!;
    const rotated = await acquire(changedEnv);
    expect(rotated.url).not.toBe(first.url);
    rotated.release();
    const servers = (await fixtureProcessEnvs(directory)).filter((entry) => entry.action === "serve");
    expect(servers).toHaveLength(2);
    expect(servers.map((entry) => entry.providerToken)).toEqual(["provider-secret-one", "provider-secret-two"]);
    expect(servers.map((entry) => entry.runId)).toEqual([null, null]);
    expect(servers[1]?.config).not.toContain("provider-secret-two");
    await expect(fs.stat(previousConfig)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads an old bound session after restart with its durable managed config when the Run config was removed", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-stale-history-config-");
    const command = await makeOpenCodeFixture(directory);
    const oldEnv = managedFixtureEnv(directory, "run-r1");
    const binding = {
      id: "binding-a",
      orgId: "org-a",
      hostId: "local",
      profileId: "opencode-profile",
      workspaceBindingId: "workspace-binding-a",
    };
    const workspace = { workspaceId: "workspace-a", workspaceBindingId: binding.workspaceBindingId };
    const durableConfigPath = path.join(oldEnv.XDG_CONFIG_HOME, "opencode", "opencode.json");
    const durableConfig = JSON.stringify({ provider: { managed: { options: { apiKey: "durable-config-secret" } } } });
    const baseSession = sessionFor(directory, command);
    const session = {
      ...baseSession,
      sessionParams: {
        ...baseSession.sessionParams,
        exportEnv: oldEnv,
        profileBindingId: binding.id,
        profileOrgId: binding.orgId,
        workspaceBindingId: binding.workspaceBindingId,
        workspaceId: workspace.workspaceId,
        providerVersion: "fixture-opencode",
      },
    };
    const adapter = createOpenCodeLocalProviderCapabilityResolver(() => ({
      binding,
      command,
      cwd: directory,
      serverUrl: session.sessionParams.serverUrl,
      providerVersion: "fixture-opencode",
    }))("opencode_local", binding)!;
    await writeFixtureConfig(oldEnv.OPENCODE_CONFIG);
    await writeFixtureConfig(durableConfigPath);
    await fs.writeFile(durableConfigPath, durableConfig, "utf8");
    await fs.rm(oldEnv.OPENCODE_CONFIG);

    const unrelatedConfig = path.join(directory, "unrelated-config.json");
    const inheritedConfig = process.env.OPENCODE_CONFIG;
    const inheritedContent = process.env.OPENCODE_CONFIG_CONTENT;
    const inheritedDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG = unrelatedConfig;
    process.env.OPENCODE_CONFIG_CONTENT = "untrusted-content";
    process.env.OPENCODE_CONFIG_DIR = directory;
    try {
      const selector = { kind: "opencode_input", sessionId: session.sessionId, userMessageId: "provider-user-1", terminalMessageIds: ["provider-assistant-1"] };
      const transcript = await adapter.transcript.readRange({ runtimeType: "opencode_local", session, selector, binding, workspace });
      expect(transcript).toMatchObject({ availability: "available", completeness: "complete" });
      expect(transcript.items.map((item) => item.sourceEntryId)).toEqual(["provider-user-1", "provider-assistant-1"]);
      expect(session.sessionParams.exportEnv).toEqual(oldEnv);
      expect(JSON.stringify(session.sessionParams)).not.toContain("durable-config-secret");
      expect(await fs.readFile(durableConfigPath, "utf8")).toBe(durableConfig);

      const exportsAfterRead = (await fixtureProcessEnvs(directory)).filter((entry) => entry.action === "export");
      expect(exportsAfterRead).toHaveLength(1);
      expect(exportsAfterRead[0]).toMatchObject({ config: durableConfigPath, configContent: null, configDir: null });

      const mismatchedProfile = {
        ...session,
        sessionParams: { ...session.sessionParams, profileId: "different-profile" },
      };
      await expect(adapter.transcript.readRange({ runtimeType: "opencode_local", session: mismatchedProfile, selector, binding, workspace }))
        .resolves.toMatchObject({ availability: "incompatible" });
      expect((await fixtureProcessEnvs(directory)).filter((entry) => entry.action === "export")).toHaveLength(1);

      const forkRequests: Array<{ url: string; init?: RequestInit }> = [];
      stubForkEndpoint(forkRequests);
      const fork = await adapter.fork.fork({
        runtimeType: "opencode_local",
        session,
        boundary: "provider-assistant-1",
        selector,
        binding,
        workspace,
      });
      expect(fork.session.sessionParams.exportEnv).toEqual(expect.not.objectContaining({ OPENCODE_CONFIG: expect.anything() }));
      expect(forkRequests.some((request) => request.url.includes("/session/oc-session-1/fork"))).toBe(true);
      const processEnvs = await fixtureProcessEnvs(directory);
      const exportEnvs = processEnvs.filter((entry) => entry.action === "export");
      expect(exportEnvs.map((entry) => entry.config)).toEqual([durableConfigPath, null, null]);
      expect(processEnvs.every((entry) => entry.configContent === null && entry.configDir === null)).toBe(true);

      const malformed = { ...session, sessionParams: { ...session.sessionParams, exportEnv: { ...oldEnv, OPENCODE_CONFIG: unrelatedConfig } } };
      await expect(adapter.transcript.readRange({ runtimeType: "opencode_local", session: malformed, selector, binding, workspace }))
        .resolves.toMatchObject({ availability: "incompatible" });
      await expect(adapter.fork.fork({ runtimeType: "opencode_local", session: malformed, boundary: "provider-assistant-1", binding, workspace }))
        .rejects.toMatchObject({ status: "unsupported" });
    } finally {
      if (inheritedConfig === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = inheritedConfig;
      if (inheritedContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = inheritedContent;
      if (inheritedDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = inheritedDir;
    }
  });

  it("exports the exact provider range and never uses the Rudder input id as a provider boundary", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-export-");
    const command = await makeOpenCodeFixture(directory);
    const result = await readOpenCodeNativeTranscript({
      runtimeType: "opencode_local",
      session: sessionFor(directory, command),
      selector: {
        kind: "opencode_input",
        sessionId: "oc-session-1",
        userMessageId: "rudder-chat-message-id",
        terminalMessageIds: ["provider-assistant-1"],
      },
      readerInput: {},
      range: { fromExclusive: "provider-user-1", throughInclusive: "provider-assistant-1" },
      binding: { hostId: "local", profileId: "opencode-profile" },
    });
    expect(result.availability).toBe("available");
    expect(result.items.map((item) => item.id)).toEqual(["provider-assistant-1"]);
    expect(result.items[0]).toMatchObject({ origin: "native", sourceEntryId: "provider-assistant-1" });
    const args = JSON.parse(await fs.readFile(path.join(directory, "export-argv.json"), "utf8")) as string[];
    expect(args).toEqual(["export", "oc-session-1"]);
    expect(args).not.toContain("--pure");
  });

  it("reads a selected transcript from the session API when CLI export is truncated", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-transcript-truncated-");
    const command = await makeOpenCodeFixture(directory, {
      exportOverride: { info: { id: "oc-session-1", padding: "x".repeat(100_000) }, messages: [] },
      truncateExportBytes: 65_536,
    });
    const result = await readOpenCodeNativeTranscript({
      runtimeType: "opencode_local",
      session: sessionFor(directory, command),
      selector: { kind: "opencode_input", sessionId: "oc-session-1", userMessageId: "provider-user-1", terminalMessageIds: ["provider-assistant-1"] },
      binding: { hostId: "local", profileId: "opencode-profile" },
    });
    expect(result.availability).toBe("available");
    expect(result.items.map((item) => item.sourceEntryId)).toEqual(["provider-user-1", "provider-assistant-1"]);
    const requests = await fixtureRequests(directory);
    expect(requests.some((request) => request.method === "GET" && request.url?.startsWith("/session/oc-session-1/message?"))).toBe(true);
    expect(requests.every((request) => request.authorized === true)).toBe(true);
  });

  it("rejects a terminal message that belongs to another Run input", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-cross-run-range-");
    const command = await makeOpenCodeFixture(directory, {
      sourceExport: {
        info: { id: "oc-session-1", time: { updated: 4 } },
        messages: [
          { info: { id: "run-a-user", role: "user", sessionID: "oc-session-1" }, parts: [{ type: "text", text: "first run" }] },
          { info: { id: "run-a-assistant", role: "assistant", parentID: "run-a-user", sessionID: "oc-session-1", finish: "stop", time: { completed: 2 } }, parts: [{ type: "text", text: "first answer" }] },
          { info: { id: "run-b-user", role: "user", parentID: "run-a-assistant", sessionID: "oc-session-1" }, parts: [{ type: "text", text: "second run" }] },
          { info: { id: "run-b-assistant", role: "assistant", parentID: "run-b-user", sessionID: "oc-session-1", finish: "stop", time: { completed: 4 } }, parts: [{ type: "text", text: "second answer" }] },
        ],
      },
    });
    const result = await readOpenCodeNativeTranscript({
      runtimeType: "opencode_local",
      session: sessionFor(directory, command),
      selector: {
        kind: "opencode_input",
        sessionId: "oc-session-1",
        userMessageId: "run-a-user",
        terminalMessageIds: ["run-b-assistant"],
      },
      binding: { hostId: "local", profileId: "opencode-profile" },
    });
    expect(result).toMatchObject({ availability: "incompatible", completeness: "unknown", items: [] });
  });

  it("projects only entries belonging to the selected native Part range", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-part-range-");
    const command = await makeOpenCodeFixture(directory, {
      sourceExport: {
        info: { id: "oc-session-1", time: { updated: 4 } },
        messages: [
          { info: { id: "provider-user-1", role: "user", sessionID: "oc-session-1" }, parts: [{ id: "part-user", type: "text", text: "inspect the file" }] },
          {
            info: { id: "provider-assistant-1", role: "assistant", parentID: "provider-user-1", sessionID: "oc-session-1", finish: "stop", time: { completed: 4 } },
            parts: [
              { id: "part-reasoning", type: "reasoning", text: "checking" },
              { id: "part-tool", type: "tool", tool: "read_file", callID: "call-1", state: { status: "completed", input: { path: "README.md" }, output: "file contents" } },
              { id: "part-answer", type: "text", text: "Here is the result." },
            ],
          },
        ],
      },
    });
    const result = await readOpenCodeNativeTranscript({
      runtimeType: "opencode_local",
      session: sessionFor(directory, command),
      selector: {
        kind: "opencode_input",
        sessionId: "oc-session-1",
        userMessageId: "provider-user-1",
        terminalMessageIds: ["provider-assistant-1"],
      },
      range: { itemId: "part-tool" },
      binding: { hostId: "local", profileId: "opencode-profile" },
    });
    expect(result.items.map((item) => item.kind)).toEqual(["tool_call", "tool_result"]);
    expect(result.items.map((item) => item.sourcePartId)).toEqual(["part-tool", "part-tool"]);
    expect(result.items.every((item) => (item.payload as { part?: { id?: string } }).part?.id === "part-tool")).toBe(true);
  });

  it("normalizes text, reasoning, and tool parts into valid transcript entries", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-reader-entries-");
    const command = await makeOpenCodeFixture(directory, {
      sourceExport: {
        info: { id: "oc-session-1", time: { updated: 4 } },
        messages: [
          {
            info: { id: "provider-user-1", role: "user", sessionID: "oc-session-1" },
            parts: [{ type: "text", text: "inspect the file" }],
          },
          {
            info: {
              id: "provider-assistant-1",
              role: "assistant",
              parentID: "provider-user-1",
              sessionID: "oc-session-1",
              finish: "stop",
              time: { created: 2, completed: 4 },
            },
            parts: [
              { type: "reasoning", text: "checking" },
              { type: "tool", tool: "read_file", callID: "call-1", state: { status: "completed", input: { path: "README.md" }, output: "file contents" } },
              { type: "text", text: "Here is the result." },
            ],
          },
        ],
      },
    });
    const result = await readOpenCodeNativeTranscript({
      runtimeType: "opencode_local",
      session: sessionFor(directory, command),
      selector: {
        kind: "opencode_input",
        sessionId: "oc-session-1",
        userMessageId: "provider-user-1",
        terminalMessageIds: ["provider-assistant-1"],
      },
      binding: { hostId: "local", profileId: "opencode-profile" },
    });

    expect(result).toMatchObject({ availability: "available", completeness: "complete" });
    expect(result.items).toHaveLength(5);
    const entries = result.items.map((item) => item.entry as { kind?: unknown } | undefined);
    expect(result.items.every((item) => {
      const kind = item.kind;
      return item.entry !== undefined && typeof kind === "string" && !kind.startsWith("opencode_");
    })).toBe(true);
    expect(entries.map((entry) => entry?.kind)).toEqual([
      "user",
      "thinking",
      "tool_call",
      "tool_result",
      "assistant",
    ]);
    expect(result.items.map((item) => item.sourceEntryId)).toEqual([
      "provider-user-1",
      "provider-assistant-1",
      "provider-assistant-1",
      "provider-assistant-1",
      "provider-assistant-1",
    ]);
    expect(result.items[2]).toMatchObject({
      kind: "tool_call",
      entry: { kind: "tool_call", name: "read_file", input: { path: "README.md" }, toolUseId: "call-1" },
      payload: { entry: { kind: "tool_call" } },
    });
    expect(result.items[3]).toMatchObject({
      kind: "tool_result",
      entry: { kind: "tool_result", toolUseId: "call-1", content: "file contents", isError: false },
    });
  });

  it("returns missing/unknown for an unresolved boundary without exporting the full session", async () => {
    const cases: Array<{ label: string; selector?: unknown }> = [
      { label: "missing-selector" },
      { label: "pending-selector", selector: { kind: "pending", runtimeType: "opencode_local" } },
      { label: "unresolved-selector", selector: { kind: "unresolved", runtimeType: "opencode_local" } },
      { label: "empty-boundary", selector: { kind: "opencode_input", terminalMessageIds: [] } },
      { label: "empty-partial-boundary", selector: { kind: "opencode_input", userMessageId: "provider-user-1", terminalMessageIds: [], observedAssistantMessageIds: [], completeness: "partial" } },
      { label: "unmarked-observed-boundary", selector: { kind: "opencode_input", userMessageId: "provider-user-1", terminalMessageIds: [], observedAssistantMessageIds: ["provider-assistant-1"] } },
    ];

    for (const testCase of cases) {
      const directory = await makeFixtureDirectory(`rudder-opencode-reader-${testCase.label}-`);
      const command = await makeOpenCodeFixture(directory);
      const result = await readOpenCodeNativeTranscript({
        runtimeType: "opencode_local",
        session: sessionFor(directory, command),
        selector: testCase.selector,
        binding: { hostId: "local", profileId: "opencode-profile" },
      });
      expect(result).toMatchObject({ availability: "missing", completeness: "unknown", items: [] });
      expect(result.revision).toMatch(/^unknown:/u);
      await expect(fs.access(path.join(directory, "export-argv.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("calls the provider fork endpoint with the exact message boundary and rejects profile drift", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-fork-");
    const command = await makeOpenCodeFixture(directory);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "oc-child", parentID: "oc-session-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const fork = await forkOpenCodeNativeSession({
      runtimeType: "opencode_local",
      session: sessionFor(directory, command),
      boundary: "provider-assistant-1",
      selector: { kind: "opencode_input", terminalMessageIds: ["provider-assistant-1"] },
      binding: { hostId: "local", profileId: "opencode-profile" },
    });
    expect(fork.session.sessionId).toBe("oc-child");
    const forkRequest = requests.find((request) => request.url.includes("/session/oc-session-1/fork"));
    expect(forkRequest).toBeDefined();
    expect(JSON.parse(String(forkRequest?.init?.body))).toEqual({ messageID: "provider-user-2" });
    expect(fork).toMatchObject({
      boundary: "provider-assistant-1",
      sourceBoundary: "provider-assistant-1",
      identityMap: {
        "provider-user-1": "child-user-1",
        "provider-assistant-1": "child-assistant-1",
      },
    });
    await expect(forkOpenCodeNativeSession({
      runtimeType: "opencode_local",
      session: sessionFor(directory, command),
      boundary: "provider-assistant-1",
      binding: { hostId: "local", profileId: "other-profile" },
    })).rejects.toMatchObject({ status: "unsupported" });
  });

  it("serializes Fork with Side Chat descendant preflight for the same provider session", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-fork-cleanup-race-");
    const command = await makeOpenCodeFixture(directory);
    const binding = { hostId: "local", profileId: "opencode-profile" };
    const requests: Array<{ url: string; method: string }> = [];
    let children: Array<{ id: string }> = [];
    let healthRequests = 0;
    let resolveForkRequest!: () => void;
    let resolveCleanupHealth!: () => void;
    let releaseFork!: () => void;
    const forkRequest = new Promise<void>((resolve) => { resolveForkRequest = resolve; });
    const cleanupHealth = new Promise<void>((resolve) => { resolveCleanupHealth = resolve; });
    const forkGate = new Promise<void>((resolve) => { releaseFork = resolve; });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    const cleanupDocument = {
      paths: {
        "/session/{sessionID}": {
          get: { operationId: "session.get" },
          delete: {
            operationId: "session.delete",
            description: "Delete a session and permanently remove all associated data, including messages and history.",
            responses: { "200": { content: { "application/json": { schema: { type: "boolean" } } } } },
          },
        },
        "/session/{sessionID}/children": {
          get: {
            operationId: "session.children",
            description: "Retrieve all child sessions that were forked from the specified parent session.",
          },
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? "GET";
      requests.push({ url: parsed.pathname, method });
      if (parsed.pathname === "/global/health") {
        healthRequests += 1;
        if (healthRequests === 3) resolveCleanupHealth();
        return json({ version: "fixture-opencode" });
      }
      if (parsed.pathname === "/doc") return json(cleanupDocument);
      if (parsed.pathname === "/session/oc-session-1" && method === "GET") {
        return json({ id: "oc-session-1", parentID: "side-chat-parent" });
      }
      if (parsed.pathname === "/session/oc-session-1/children") return json(children);
      if (parsed.pathname === "/session/oc-session-1" && method === "DELETE") return json(true);
      if (parsed.pathname === "/session/oc-session-1/fork") {
        resolveForkRequest();
        await forkGate;
        children = [{ id: "oc-grandchild" }];
        return json({ id: "oc-child", parentID: "oc-session-1" });
      }
      return json({ message: "missing fixture route" }, 404);
    }));

    const session = sessionFor(directory, command);
    const forkResultPromise = forkOpenCodeNativeSession({
      runtimeType: "opencode_local",
      session,
      boundary: "provider-assistant-1",
      selector: { kind: "opencode_input", terminalMessageIds: ["provider-assistant-1"] },
      binding,
    }).then((value) => ({ status: "fulfilled" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));
    let cleanupResultPromise: Promise<
      | { status: "fulfilled"; value: void }
      | { status: "rejected"; error: unknown }
    > | undefined;
    try {
      await forkRequest;
      cleanupResultPromise = deleteOpenCodeSideChatForkSession({
        session,
        expectedParentSessionId: "side-chat-parent",
        binding,
        profileCommand: command,
        profileCwd: directory,
      }).then((value) => ({ status: "fulfilled" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));
      await cleanupHealth;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(requests.some((request) => request.url === "/doc")).toBe(false);
    } finally {
      releaseFork();
    }

    const [forkResult, cleanupResult] = await Promise.all([forkResultPromise, cleanupResultPromise!]);
    expect(forkResult.status).toBe("fulfilled");
    expect(cleanupResult.status).toBe("rejected");
    if (cleanupResult.status === "rejected") {
      expect(cleanupResult.error).toMatchObject({ status: "unsupported" });
      expect((cleanupResult.error as Error).message).toContain("provider-side descendants");
    }
    expect(requests.filter((request) => request.url === "/session/oc-session-1/children")).toHaveLength(1);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("omits messageID when the completed assistant boundary is the final source message", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-fork-final-");
    const command = await makeOpenCodeFixture(directory, {
      sourceExport: {
        info: { id: "oc-session-1", time: { updated: 2 } },
        messages: [
          { info: { id: "provider-user-1", role: "user", sessionID: "oc-session-1" }, parts: [{ type: "text", text: "user input" }] },
          {
            info: { id: "provider-assistant-1", role: "assistant", parentID: "provider-user-1", sessionID: "oc-session-1", finish: "stop", time: { completed: 3 } },
            parts: [{ type: "text", text: "native answer" }],
          },
        ],
      },
      childExport: {
        info: { id: "oc-child", time: { updated: 3 } },
        messages: [
          { info: { id: "child-user-1", role: "user", sessionID: "oc-child" }, parts: [{ type: "text", text: "user input" }] },
          {
            info: { id: "child-assistant-1", role: "assistant", parentID: "child-user-1", sessionID: "oc-child", finish: "stop", time: { completed: 3 } },
            parts: [{ type: "text", text: "native answer" }],
          },
        ],
      },
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    stubForkEndpoint(requests);
    const fork = await forkOpenCodeNativeSession({
      runtimeType: "opencode_local",
      session: sessionFor(directory, command),
      boundary: "provider-assistant-1",
      selector: { kind: "opencode_input", sessionId: "oc-session-1", terminalMessageIds: ["provider-assistant-1"] },
      binding: { hostId: "local", profileId: "opencode-profile" },
    });
    const forkRequest = requests.find((request) => request.url.includes("/session/oc-session-1/fork"));
    expect(forkRequest).toBeDefined();
    expect(JSON.parse(String(forkRequest?.init?.body))).toEqual({});
    expect(fork.identityMap).toEqual({
      "provider-user-1": "child-user-1",
      "provider-assistant-1": "child-assistant-1",
    });
  });

  it("rejects a fork boundary that is not a completed assistant", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-fork-incomplete-");
    const command = await makeOpenCodeFixture(directory, {
      sourceExport: {
        info: { id: "oc-session-1", time: { updated: 2 } },
        messages: [
          { info: { id: "provider-user-1", role: "user", sessionID: "oc-session-1" }, parts: [{ type: "text", text: "user input" }] },
          {
            info: { id: "provider-assistant-1", role: "assistant", parentID: "provider-user-1", sessionID: "oc-session-1" },
            parts: [{ type: "text", text: "still running" }],
          },
        ],
      },
    });
    await expect(forkOpenCodeNativeSession({
      runtimeType: "opencode_local",
      session: sessionFor(directory, command),
      boundary: "provider-assistant-1",
      selector: { kind: "opencode_input", sessionId: "oc-session-1", terminalMessageIds: ["provider-assistant-1"] },
      binding: { hostId: "local", profileId: "opencode-profile" },
    })).rejects.toMatchObject({ status: "unsupported", message: expect.stringContaining("completed assistant") });
  });

  it("fails closed for added, truncated, changed, or ambiguous child prefixes", async () => {
    const sourceMessages: FixtureMessage[] = [
      { info: { id: "provider-user-1", role: "user", sessionID: "oc-session-1" }, parts: [{ type: "text", text: "user input" }] },
      {
        info: { id: "provider-assistant-1", role: "assistant", parentID: "provider-user-1", sessionID: "oc-session-1", finish: "stop", time: { completed: 3 } },
        parts: [{ type: "text", text: "native answer" }],
      },
    ];
    const validChildMessages: FixtureMessage[] = [
      { info: { id: "child-user-1", role: "user", sessionID: "oc-child" }, parts: [{ type: "text", text: "user input" }] },
      {
        info: { id: "child-assistant-1", role: "assistant", parentID: "child-user-1", sessionID: "oc-child", finish: "stop", time: { completed: 3 } },
        parts: [{ type: "text", text: "native answer" }],
      },
    ];
    const cases: Array<[string, FixtureMessage[], string]> = [
      ["added tail", [...validChildMessages, { info: { id: "child-tail", role: "user", sessionID: "oc-child" }, parts: [{ type: "text", text: "unexpected tail" }] }], "exactly"],
      ["truncated prefix", validChildMessages.slice(0, 1), "exactly"],
      ["changed content", [validChildMessages[0], { ...validChildMessages[1], parts: [{ type: "text", text: "changed answer" }] }], "exact source message prefix"],
      ["ambiguous prefix", [
        { info: { id: "child-user-1", role: "user", sessionID: "oc-child" }, parts: [{ type: "text", text: "same" }] },
        { info: { id: "child-user-2", role: "user", sessionID: "oc-child" }, parts: [{ type: "text", text: "same" }] },
        { info: { id: "child-assistant-1", role: "assistant", sessionID: "oc-child", finish: "stop", time: { completed: 3 } }, parts: [{ type: "text", text: "native answer" }] },
      ], "ambiguous message content"],
    ];

    for (const [label, childMessages, expectedMessage] of cases) {
      const directory = await makeFixtureDirectory(`rudder-opencode-fork-${label.replace(/\s+/gu, "-")}-`);
      const sourceExport: FixtureExport = {
        info: { id: "oc-session-1", time: { updated: 2 } },
        messages: label === "ambiguous prefix"
          ? [
            { info: { id: "provider-user-1", role: "user", sessionID: "oc-session-1" }, parts: [{ type: "text", text: "same" }] },
            { info: { id: "provider-user-2", role: "user", sessionID: "oc-session-1" }, parts: [{ type: "text", text: "same" }] },
            { info: { id: "provider-assistant-1", role: "assistant", sessionID: "oc-session-1", finish: "stop", time: { completed: 3 } }, parts: [{ type: "text", text: "native answer" }] },
          ]
          : sourceMessages,
      };
      const command = await makeOpenCodeFixture(directory, {
        sourceExport,
        childExport: { info: { id: "oc-child", time: { updated: 3 } }, messages: childMessages },
      });
      stubForkEndpoint([]);
      await expect(forkOpenCodeNativeSession({
        runtimeType: "opencode_local",
        session: sessionFor(directory, command),
        boundary: "provider-assistant-1",
        selector: { kind: "opencode_input", sessionId: "oc-session-1", terminalMessageIds: ["provider-assistant-1"] },
        binding: { hostId: "local", profileId: "opencode-profile" },
      })).rejects.toMatchObject({ status: "unsupported", message: expect.stringContaining(expectedMessage) });
    }
  });

  it("keeps transcript/fork declarations unresolved until a profile resolver attests persisted transport state", () => {
    expect(runtimeProviderCapabilities.transcript.evidence).toMatchObject({ status: "unknown", profileBound: false, profileRequired: true });
    expect(runtimeProviderCapabilities.transcript.readRange).toBeTypeOf("function");
    expect(runtimeProviderCapabilities.fork.evidence).toMatchObject({ status: "unknown", profileBound: false, profileRequired: true });
    expect(runtimeProviderCapabilities.fork.fork).toBeTypeOf("function");
    expect(runtimeProviderCapabilities.control.steer.evidence.status).toBe("unknown");
    expect(runtimeProviderCapabilities.control.interrupt.evidence.status).toBe("unknown");
  });

  it("round-trips managed native session parameters through the codec", () => {
    const encoded = sessionCodec.serialize({
      sessionId: "oc-session-1",
      cwd: "/tmp/work",
      serverUrl: "http://127.0.0.1:1234",
      serverCommand: "opencode",
      exportCommand: "opencode",
      exportEnv: { OPENCODE_CONFIG: "/tmp/opencode.json" },
      transport: "opencode-managed-server-http",
      hostId: "local",
      profileId: "opencode-profile",
    });
    expect(encoded).toMatchObject({
      serverUrl: "http://127.0.0.1:1234",
      exportCommand: "opencode",
      exportEnv: { OPENCODE_CONFIG: "/tmp/opencode.json" },
      profileId: "opencode-profile",
    });
  });

  it("rejects unknown export env before persisted resume and drops opaque bindings", async () => {
    const encoded = sessionCodec.serialize({
      sessionId: "oc-session-1",
      cwd: "/tmp/work",
      serverUrl: "http://127.0.0.1:1234",
      serverCommand: "opencode",
      exportCommand: "opencode",
      exportEnv: { OPENCODE_CONFIG: "/tmp/opencode.json" },
      transport: "opencode-managed-server-http",
      opaqueBinding: { token: "do-not-persist" },
      hostId: "local",
      profileId: "opencode-profile",
    });
    expect(encoded).not.toHaveProperty("opaqueBinding");
    expect(encoded?.exportEnv).toEqual({ OPENCODE_CONFIG: "/tmp/opencode.json" });
    expect(sessionCodec.serialize({
      sessionId: "oc-session-1",
      exportEnv: { OPENCODE_CONFIG: "/tmp/opencode.json", OPENCODE_API_KEY: "do-not-persist" },
    })).toBeNull();

    const directory = await makeFixtureDirectory("rudder-opencode-incomplete-transport-");
    const command = await makeOpenCodeFixture(directory);
    const complete = sessionFor(directory, command);
    const incomplete = {
      ...complete,
      sessionParams: { ...complete.sessionParams, serverCommand: "" },
    };
    await expect(readOpenCodeNativeTranscript({
      runtimeType: "opencode_local",
      session: incomplete,
      binding: { hostId: "local", profileId: "opencode-profile" },
    })).rejects.toMatchObject({ status: "unknown" });
  });

  it("requires the profile-bound resolver to attest persisted cwd and server transport", async () => {
    const directory = await makeFixtureDirectory("rudder-opencode-profile-drift-");
    const command = await makeOpenCodeFixture(directory);
    const binding = { hostId: "local", profileId: "opencode-profile" };
    const resolver = createOpenCodeLocalProviderCapabilityResolver(() => ({
      binding,
      command,
      cwd: directory,
      serverUrl: "http://127.0.0.1:9",
    }));
    const adapter = resolver("opencode_local", binding)!;
    const drifted = sessionFor(directory, command);
    drifted.sessionParams.cwd = path.join(directory, "other");
    await expect(adapter.transcript.readRange({
      runtimeType: "opencode_local",
      session: drifted,
      binding,
    })).resolves.toMatchObject({ availability: "incompatible" });
  });
});

import type { AgentRuntimeControlHandle } from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeCodexNativeThread } from "./app-server-native.js";
import {
  createCodexLocalProviderCapabilities,
  createCodexLocalProviderCapabilityResolver,
  type CodexAppServerProfileTransport,
  type CodexProviderBindingRef,
  type CodexProviderSessionRef,
} from "./native-capabilities.js";

let root = "";
let fakeServer = "";
let capturePath = "";

const binding: CodexProviderBindingRef = {
  hostId: "local",
  profileId: "profile-a",
  capabilityRevision: "cap-1",
};

const session: CodexProviderSessionRef = {
  sessionId: "parent-thread",
  sessionDisplayId: "parent-thread",
  sessionParams: { sessionId: "parent-thread", rootSessionId: "root-1", transport: "codex_app_server",
    profileHostId: binding.hostId, profileId: binding.profileId, capabilityRevision: binding.capabilityRevision },
};

function resultItems(
  result: readonly Record<string, unknown>[] | { items?: readonly Record<string, unknown>[] },
): readonly Record<string, unknown>[] {
  if ("items" in result) return result.items ?? [];
  return result as readonly Record<string, unknown>[];
}

async function capturedRequests(): Promise<Array<Record<string, unknown>>> {
  const content = await fs.readFile(capturePath, "utf8").catch(() => "");
  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function profile(overrides: Partial<CodexAppServerProfileTransport> = {}): CodexAppServerProfileTransport {
  return {
    binding,
    command: process.execPath,
    args: [fakeServer],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      CODEX_HOME: path.join(root, "codex-home"),
      RUDDER_NATIVE_CAPTURE: capturePath,
    },
    providerVersion: "0.155.0-alpha.9.2",
    methods: { threadResume: true, threadRead: true, threadFork: true },
    ...overrides,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-native-"));
  fakeServer = path.join(root, "fake-app-server.mjs");
  capturePath = path.join(root, "requests.ndjson");
  await fs.writeFile(fakeServer, `
import fs from "node:fs";
import readline from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const capture = (message) => {
  if (process.env.RUDDER_NATIVE_CAPTURE) {
    fs.appendFileSync(process.env.RUDDER_NATIVE_CAPTURE, JSON.stringify(message) + "\\n", "utf8");
  }
};
const parentTurns = [
  {
    id: "turn-1",
    status: "completed",
    itemsView: { type: "full" },
    items: [
      { type: "userMessage", id: "user-1", content: [{ type: "text", text: "Inspect the renderer" }] },
      { type: "mcpToolCall", id: "tool-1", server: "rudder", tool: "rudder_issue_context", result: { issueId: "issue-1", status: "open" } },
      { type: "agentMessage", id: "assistant-1", text: "The renderer is healthy." },
    ],
  },
  {
    id: "turn-2",
    status: "inProgress",
    itemsView: { type: "full" },
    items: [{ type: "agentMessage", id: "assistant-2", text: "Still running" }],
  },
];
const childTurns = [{
  id: "child-turn-1",
  status: "completed",
  itemsView: { type: "full" },
  items: [{ type: "agentMessage", id: "child-assistant-1", text: "Child branch" }],
}];
const thread = (id, turns, forkedFromId = null) => ({
  id,
  sessionId: id === "child-thread" ? "child-root" : "root-1",
  forkedFromId,
  ephemeral: false,
  model: "gpt-test",
  modelProvider: "openai",
  cwd: process.cwd(),
  updatedAt: 1726963200,
  turns,
});

capture({ kind: "process", cwd: process.cwd(), codexHome: process.env.CODEX_HOME ?? null });
capture({ kind: "argv", args: process.argv.slice(2) });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", serverInfo: { version: "0.155.0-alpha.9.2" } } });
    return;
  }
  if (message.method === "thread/read") {
    if (process.env.RUDDER_NATIVE_HANG_READ === "1") return;
    if (process.env.RUDDER_NATIVE_BAD_READ === "1") {
      send({ id: message.id, result: { thread: thread(message.params.threadId, [{
        id: "turn-1",
        status: "completed",
        itemsView: { type: "notLoaded" },
        items: [],
      }]) } });
      return;
    }
    send({ id: message.id, result: { thread: thread(message.params.threadId, parentTurns) } });
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: thread(message.params.threadId, []) } });
    return;
  }
  if (message.method === "thread/fork") {
    const childId = process.env.RUDDER_NATIVE_BAD_FORK === "1" ? message.params.threadId : "child-thread";
    const returnedTurns = process.env.RUDDER_NATIVE_BAD_FORK_BOUNDARY === "1"
      ? [...childTurns, { ...childTurns[0], id: "child-turn-extra" }]
      : childTurns;
    send({ id: message.id, result: { thread: thread(childId, returnedTurns, message.params.threadId) } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "unknown method" } });
});
`, "utf8");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Codex native history and fork capabilities", () => {
  it("rejects missing and mismatched native session attestations before opening a provider", async () => {
    const authorized = { ...binding, id: "binding-a", orgId: "org-a", workspaceBindingId: "workspace-a" };
    const transport = profile({ binding: authorized });
    const capabilities = createCodexLocalProviderCapabilities(transport);
    const params = { ...session.sessionParams, profileBindingId: authorized.id,
      profileOrgId: authorized.orgId, workspaceBindingId: authorized.workspaceBindingId };
    for (const key of ["transport", "profileHostId", "profileId", "profileOrgId", "profileBindingId", "workspaceBindingId", "capabilityRevision"]) {
      for (const value of [undefined, "foreign-identity"]) {
        const foreign = { ...session, sessionParams: { ...params, [key]: value } };
        await expect(capabilities.transcript!.readRange!({
          runtimeType: "codex_local", binding: authorized, session: foreign,
        })).rejects.toThrow("attestation");
        await expect(capabilities.fork!.fork!({
          runtimeType: "codex_local", binding: authorized, session: foreign, boundary: "turn-1",
        })).rejects.toThrow("attestation");
        await expect(resumeCodexNativeThread({
          runtimeType: "codex_local", binding: authorized, session: foreign,
        }, transport)).rejects.toThrow("attestation");
      }
    }
    expect(await capturedRequests()).toEqual([]);
  });

  it("reads one authorized turn, applies direct ranges, and preserves tool results", async () => {
    const resolver = createCodexLocalProviderCapabilityResolver((requested) => {
      expect(requested).toEqual(binding);
      return profile();
    });
    const capabilities = resolver("codex_local", binding)!;
    expect(capabilities.transcript?.evidence).toMatchObject({ status: "supported", profileBound: true });
    expect(capabilities.control?.steer?.evidence).toMatchObject({ status: "supported", profileBound: true });

    const readRange = capabilities.transcript!.readRange!;
    const runResult = await readRange({
      runtimeType: "codex_local",
      session,
      selector: { kind: "codex_turn", threadId: "parent-thread", turnId: "turn-1" },
      binding,
      range: { itemId: "tool-1" },
      readerInput: { readonly: true, scope: "run" },
    });
    const runItems = resultItems(runResult);
    expect(runItems.map((item) => item.id)).toEqual(["user-1", "tool-1", "tool-1:tool_result:1", "assistant-1"]);
    expect(runItems.map((item) => item.entry)).toMatchObject([
      { kind: "user", text: "Inspect the renderer" },
      { kind: "tool_call", toolUseId: "tool-1", name: "mcp__rudder__rudder_issue_context" },
      { kind: "tool_result", toolUseId: "tool-1", isError: false },
      { kind: "assistant", text: "The renderer is healthy." },
    ]);
    expect(runItems[1]?.payload).toMatchObject({
      threadId: "parent-thread",
      turnId: "turn-1",
      item: { type: "mcpToolCall", result: { issueId: "issue-1" } },
    });

    const directResult = await readRange({
      runtimeType: "codex_local",
      session,
      binding,
      range: { fromExclusive: "user-1", throughInclusive: "tool-1" },
    });
    const directItems = resultItems(directResult);
    expect(directItems.map((item) => item.id)).toEqual(["tool-1", "tool-1:tool_result:1"]);

    for (const range of [
      { fromExclusive: "tool-1" },
      { after: "tool-1:tool_result:1" },
    ]) {
      const afterTool = await readRange({ runtimeType: "codex_local", session, binding, range });
      expect(resultItems(afterTool).map((item) => item.id)).toEqual(["assistant-1", "assistant-2"]);
    }
    const boundedTool = await readRange({
      runtimeType: "codex_local", session, binding,
      range: { start: "tool-1", end: "tool-1" },
    });
    expect(resultItems(boundedTool).map((item) => item.id)).toEqual(["tool-1", "tool-1:tool_result:1"]);

    const requests = await capturedRequests();
    expect(requests.find((request) => request.kind === "process")).toMatchObject({
      kind: "process",
      cwd: await fs.realpath(root),
      codexHome: path.join(root, "codex-home"),
    });
    expect(requests.find((request) => request.kind === "argv")).toMatchObject({
      kind: "argv",
      args: ["app-server", "--stdio"],
    });
  });

  it("forks only through a completed turn and preserves lineage across a new native session tree", async () => {
    const capabilities = createCodexLocalProviderCapabilities(profile());
    const fork = capabilities.fork!.fork!;
    const result = await fork({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
      binding,
    });

    expect(result).toMatchObject({
      continuity: "native",
      boundary: "turn-1",
      sourceBoundary: "turn-1",
      identityMap: { "turn-1": "child-turn-1" },
      session: {
        sessionId: "child-thread",
        sessionDisplayId: "child-thread",
        sessionParams: {
          sessionId: "child-thread",
          threadId: "child-thread",
          rootSessionId: "child-root",
          forkedFromId: "parent-thread",
          transport: "codex_app_server",
          profileHostId: "local",
          profileId: "profile-a",
          capabilityRevision: "cap-1",
        },
      },
    });
    expect(result.session.sessionId).not.toBe(session.sessionId);

    const requests = await capturedRequests();
    const forkRequest = requests.find((request) => request.method === "thread/fork");
    expect(forkRequest).toMatchObject({
      method: "thread/fork",
      params: {
        threadId: "parent-thread",
        lastTurnId: "turn-1",
        ephemeral: false,
        excludeTurns: false,
        model: "gpt-test",
        modelProvider: "openai",
        cwd: root,
      },
    });
  });

  it("reports a missing Run boundary without reading the whole session or throwing a server error", async () => {
    const capabilities = createCodexLocalProviderCapabilities(profile());
    await expect(capabilities.transcript!.readRange!({
      runtimeType: "codex_local", session, binding,
      selector: { kind: "codex_turn", threadId: "parent-thread", turnId: null },
      readerInput: { readonly: true, scope: "run" },
    })).resolves.toMatchObject({ items: [], source: "native", availability: "missing", completeness: "unknown" });
    expect(await capturedRequests()).toEqual([]);
  });

  it("uses native resume and refuses an in-progress fork boundary", async () => {
    const current = profile();
    await expect(resumeCodexNativeThread({ runtimeType: "codex_local", session, binding }, current)).resolves.toMatchObject({
      sessionId: "parent-thread",
      sessionParams: { sessionId: "parent-thread", threadId: "parent-thread", rootSessionId: "root-1" },
    });

    const capabilities = createCodexLocalProviderCapabilities(current);
    await expect(capabilities.fork!.fork!({
      runtimeType: "codex_local",
      session,
      boundary: "turn-2",
      binding,
    })).rejects.toThrow("only a completed turn is safe to fork");

    const requests = await capturedRequests();
    expect(requests.filter((request) => request.method === "thread/fork")).toHaveLength(0);
    expect(requests.some((request) => request.method === "thread/resume")).toBe(true);
  });

  it("reports provider read/fork failures and transport timeouts explicitly", async () => {
    const badRead = createCodexLocalProviderCapabilities(profile({
      env: { ...profile().env, RUDDER_NATIVE_BAD_READ: "1" },
    }));
    await expect(badRead.transcript!.readRange!({
      runtimeType: "codex_local",
      session,
      binding,
    })).resolves.toMatchObject({
      items: [],
      availability: "incompatible",
      revision: expect.stringContaining("unsupported:"),
    });

    const badFork = createCodexLocalProviderCapabilities(profile({
      env: { ...profile().env, RUDDER_NATIVE_BAD_FORK: "1" },
    }));
    await expect(badFork.fork!.fork!({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
      binding,
    })).rejects.toMatchObject({
      name: "CodexNativeCapabilityError",
      status: "unsupported",
    });

    const timedOutProfile = profile({
      env: { ...profile().env, RUDDER_NATIVE_HANG_READ: "1" },
    });
    const timedOutCapabilities = createCodexLocalProviderCapabilities(timedOutProfile);
    await expect(timedOutCapabilities.transcript!.readRange!({
      runtimeType: "codex_local",
      session,
      binding,
      signal: AbortSignal.timeout(25),
    })).resolves.toMatchObject({
      items: [],
      availability: "offline",
      revision: expect.stringContaining("unknown:"),
    });
    await expect(timedOutCapabilities.fork!.fork!({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
      binding,
      signal: AbortSignal.timeout(25),
    })).rejects.toMatchObject({
      name: "CodexNativeCapabilityError",
      status: "unknown",
      message: expect.stringContaining("unavailable"),
    });
  });

  it("does not launch a profile transport when method support is unknown or unsupported", async () => {
    const unknownRead = createCodexLocalProviderCapabilities(profile({
      methods: { threadResume: true, threadFork: true },
    }));
    await expect(unknownRead.transcript!.readRange!({
      runtimeType: "codex_local",
      session,
      binding,
    })).rejects.toMatchObject({ name: "CodexNativeCapabilityError", status: "unknown" });

    const unsupportedFork = createCodexLocalProviderCapabilities(profile({
      methods: { threadResume: true, threadRead: true, threadFork: false },
    }));
    await expect(unsupportedFork.fork!.fork!({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
      binding,
    })).rejects.toMatchObject({ name: "CodexNativeCapabilityError", status: "unsupported" });

    expect(await capturedRequests()).toEqual([]);
  });

  it("rejects a fork response that includes turns after the requested boundary", async () => {
    const capabilities = createCodexLocalProviderCapabilities(profile({
      env: { ...profile().env, RUDDER_NATIVE_BAD_FORK_BOUNDARY: "1" },
    }));
    await expect(capabilities.fork!.fork!({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
      binding,
    })).rejects.toMatchObject({
      name: "CodexNativeCapabilityError",
      status: "unsupported",
      message: expect.stringContaining("exactly the 1 turn through boundary turn-1"),
    });
  });

  it("returns explicit unknown or unsupported capability evidence before transport I/O", () => {
    const resolver = createCodexLocalProviderCapabilityResolver(undefined);
    const unbound = resolver("codex_local", null)!;
    expect(unbound.transcript?.evidence).toMatchObject({ status: "unknown" });
    expect(unbound.fork?.evidence).toMatchObject({ status: "unknown" });

    const unsupported = resolver("codex_local", binding)!;
    expect(unsupported.transcript?.evidence).toMatchObject({ status: "unknown" });

    const versionUnknown = createCodexLocalProviderCapabilities(profile({ providerVersion: null }));
    expect(versionUnknown.transcript?.evidence).toMatchObject({ status: "unknown" });
    expect(versionUnknown.fork?.evidence).toMatchObject({ status: "unknown" });

    const methodUnsupported = createCodexLocalProviderCapabilities(profile({ methods: { threadRead: false, threadFork: false } }));
    expect(methodUnsupported.transcript?.evidence).toMatchObject({ status: "unsupported" });
    expect(methodUnsupported.fork?.evidence).toMatchObject({ status: "unsupported" });

    const mismatched = createCodexLocalProviderCapabilityResolver(() => profile({
      binding: { ...binding, profileId: "other-profile" },
    }))!("codex_local", binding)!;
    expect(mismatched.transcript?.evidence).toMatchObject({ status: "unsupported" });
    expect(mismatched.fork?.evidence).toMatchObject({ status: "unsupported" });

    const mismatchedOptionalIdentity = createCodexLocalProviderCapabilityResolver(() => profile({
      binding: { ...binding, orgId: "org-2" },
    }))!("codex_local", { ...binding, orgId: "org-1" })!;
    expect(mismatchedOptionalIdentity.transcript?.evidence).toMatchObject({ status: "unsupported" });
    expect(mismatchedOptionalIdentity.fork?.evidence).toMatchObject({ status: "unsupported" });
  });

  it("forwards native control hooks to the live App Server handle", async () => {
    const resolver = createCodexLocalProviderCapabilityResolver((requested) => {
      expect(requested).toEqual(binding);
      return profile();
    });
    const capabilities = resolver("codex_local", binding)!;
    const steer = vi.fn().mockResolvedValue({
      disposition: "accepted_current" as const,
      providerThreadId: "parent-thread",
      providerTurnId: "turn-2",
    });
    const interrupt = vi.fn().mockResolvedValue("acknowledged" as const);
    const handle = {
      runtimeType: "codex_local",
      providerThreadId: "parent-thread",
      providerTurnId: "turn-2",
      capabilities: { steer: "native" as const, interrupt: "native" as const },
      steer,
      interrupt,
      dispose: vi.fn().mockResolvedValue(undefined),
    } satisfies AgentRuntimeControlHandle;

    await expect(capabilities.control!.steer!.execute!({
      runtimeType: "codex_local",
      handle,
      binding,
      session,
      operation: { kind: "steer", input: { text: "continue", clientMessageId: "message-1" } },
    })).resolves.toMatchObject({ disposition: "accepted_current" });
    await expect(capabilities.control!.interrupt!.execute!({
      runtimeType: "codex_local",
      handle,
      binding,
      session,
      operation: { kind: "interrupt", reason: "operator_stop" },
    })).resolves.toBe("acknowledged");
    expect(steer).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledOnce();

    await expect(capabilities.control!.steer!.execute!({
      runtimeType: "codex_local",
      handle,
      binding: { ...binding, profileId: "different-profile" },
      session,
      operation: { kind: "steer", input: { text: "continue", clientMessageId: "message-mismatch" } },
    })).resolves.toMatchObject({
      disposition: "acceptance_unknown",
      reason: expect.stringContaining("binding does not match"),
    });
    expect(steer).toHaveBeenCalledOnce();

    await expect(capabilities.control!.steer!.execute!({
      runtimeType: "codex_local",
      handle: null,
      operation: { kind: "steer", input: { text: "continue", clientMessageId: "message-2" } },
    })).resolves.toMatchObject({
      disposition: "acceptance_unknown",
      reason: expect.stringContaining("live handle"),
    });
    await expect(capabilities.control!.interrupt!.execute!({
      runtimeType: "codex_local",
      handle: null,
      operation: { kind: "interrupt", reason: "operator_stop" },
    })).resolves.toBe("unverified");
  });
});

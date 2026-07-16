import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  CodexAppServerClosedError,
  CodexAppServerProtocolError,
  CodexAppServerTimeoutError,
  createCodexAppServerStdioTransport,
  type CodexAppServerTransport,
  type CodexAppServerTransportExit,
} from "./app-server-client.js";

class FakeTransport implements CodexAppServerTransport {
  readonly writes: string[] = [];
  terminated = false;
  writeError: Error | null = null;

  private readonly stdoutListeners = new Set<
    (chunk: Buffer | Uint8Array | string) => void
  >();
  private readonly exitListeners = new Set<(exit: CodexAppServerTransportExit) => void>();

  write(serializedMessage: string): void {
    if (this.writeError) throw this.writeError;
    this.writes.push(serializedMessage);
  }

  onStdout(listener: (chunk: Buffer | Uint8Array | string) => void): () => void {
    this.stdoutListeners.add(listener);
    return () => this.stdoutListeners.delete(listener);
  }

  onExit(listener: (exit: CodexAppServerTransportExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitStdout(chunk: Buffer | Uint8Array | string): void {
    for (const listener of [...this.stdoutListeners]) listener(chunk);
  }

  emitMessage(message: unknown): void {
    this.emitStdout(`${JSON.stringify(message)}\n`);
  }

  emitExit(exit: CodexAppServerTransportExit): void {
    for (const listener of [...this.exitListeners]) listener(exit);
  }

  messages(): Array<Record<string, unknown>> {
    return this.writes.flatMap((write) => write
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>));
  }
}

const clients: CodexAppServerClient[] = [];

function createClient(
  transport: FakeTransport,
  options: Partial<ConstructorParameters<typeof CodexAppServerClient>[0]> = {},
): CodexAppServerClient {
  const client = new CodexAppServerClient({
    transport,
    clientInfo: { name: "rudder-test", version: "0.0.0" },
    onError: () => undefined,
    ...options,
  });
  clients.push(client);
  return client;
}

async function initializeClient(
  client: CodexAppServerClient,
  transport: FakeTransport,
): Promise<void> {
  const initialized = client.initialize();
  expect(transport.messages()).toEqual([{
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "rudder-test", version: "0.0.0" },
      capabilities: null,
    },
  }]);
  transport.emitMessage({ id: 1, result: { serverInfo: { name: "codex" } } });
  await initialized;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose("test cleanup");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CodexAppServerClient", () => {
  it("turns an asynchronous child stdin error into a transport exit", () => {
    const childEvents = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(childEvents, {
      stdin,
      stdout,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const transport = createCodexAppServerStdioTransport(child);
    const exits: CodexAppServerTransportExit[] = [];
    const removeExitListener = transport.onExit((exit) => exits.push(exit));
    const brokenPipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });

    stdin.emit("error", brokenPipe);

    expect(exits).toEqual([{ code: null, signal: null, error: brokenPipe }]);
    removeExitListener();
    expect(() => stdin.emit("error", new Error("late pipe error"))).not.toThrow();
  });

  it("initializes once and emits initialized only after the response", async () => {
    const transport = new FakeTransport();
    const client = createClient(transport, {
      capabilities: { experimentalApi: true },
    });

    const first = client.initialize();
    const second = client.initialize();

    expect(second).toBe(first);
    expect(transport.messages()).toEqual([{
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "rudder-test", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      },
    }]);

    transport.emitMessage({ id: 1, result: { userAgent: "codex-test" } });
    await Promise.all([first, second]);
    await client.initialize();

    expect(client.state).toBe("ready");
    expect(transport.messages()).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "rudder-test", version: "0.0.0" },
          capabilities: { experimentalApi: true },
        },
      },
      { method: "initialized", params: {} },
    ]);
  });

  it("decodes split UTF-8 and drains multiple JSONL frames from one chunk", async () => {
    const transport = new FakeTransport();
    const notifications: unknown[] = [];
    const client = createClient(transport, {
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    const initialized = client.initialize();
    const frames = Buffer.from([
      JSON.stringify({ id: 1, result: { serverInfo: { name: "Codex" } } }),
      JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "调整方向" } }),
      JSON.stringify({ method: "turn/started", params: { turnId: "turn-1" } }),
      "",
    ].join("\n"), "utf8");
    const chineseStart = frames.indexOf(Buffer.from("调", "utf8"));

    expect(chineseStart).toBeGreaterThan(0);
    transport.emitStdout(frames.subarray(0, chineseStart + 1));
    transport.emitStdout(frames.subarray(chineseStart + 1));
    await initialized;
    await flushPromises();

    expect(notifications).toEqual([
      { method: "item/agentMessage/delta", params: { delta: "调整方向" } },
      { method: "turn/started", params: { turnId: "turn-1" } },
    ]);
    expect(transport.messages().at(-1)).toEqual({ method: "initialized", params: {} });
  });

  it("fails closed when chunk types change during an incomplete UTF-8 sequence", async () => {
    const transport = new FakeTransport();
    const notifications: unknown[] = [];
    const client = createClient(transport, {
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    await initializeClient(client, transport);

    const prefix = Buffer.from('{"method":"notice","params":{"text":"', "utf8");
    const partialChinese = Buffer.from("调", "utf8").subarray(0, 1);
    transport.emitStdout(Buffer.concat([prefix, partialChinese]));
    transport.emitStdout('TAIL"}}\r\n\r\n');
    await flushPromises();

    expect(notifications).toEqual([]);
    expect(client.state).toBe("failed");
    expect(client.protocolCompatible).toBe(false);
    expect(transport.terminated).toBe(true);
  });

  it("rejects an oversized unterminated frame", async () => {
    const transport = new FakeTransport();
    const client = createClient(transport, { maxFrameBytes: 16 });
    const initialized = client.initialize();

    transport.emitStdout('{"id":1,"result":{"tooLong":true}}');

    await expect(initialized).rejects.toBeInstanceOf(CodexAppServerProtocolError);
    expect(client.state).toBe("failed");
    expect(transport.terminated).toBe(true);
  });

  it("drains a final JSONL remainder before process-exit cleanup", async () => {
    const transport = new FakeTransport();
    const notifications: unknown[] = [];
    const client = createClient(transport, {
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    await initializeClient(client, transport);

    transport.emitStdout('{"method":"turn/completed","params":{"status":"completed"}}');
    transport.emitExit({ code: 0, signal: null });
    await flushPromises();

    expect(notifications).toEqual([
      { method: "turn/completed", params: { status: "completed" } },
    ]);
    expect(client.state).toBe("closed");
  });

  it("publishes process exit only after the final async notification drains", async () => {
    const transport = new FakeTransport();
    const order: string[] = [];
    let releaseNotification: (() => void) | undefined;
    const notificationBarrier = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const client = createClient(transport, {
      notificationDrainTimeoutMs: 1_000,
      onNotification: async ({ method }) => {
        order.push(`notification-start:${method}`);
        await notificationBarrier;
        order.push(`notification-end:${method}`);
      },
      onError: () => {
        order.push("exit-published");
      },
    });
    await initializeClient(client, transport);

    transport.emitStdout('{"method":"turn/completed","params":{"status":"completed"}}');
    transport.emitExit({ code: 0, signal: null });
    await flushPromises();

    expect(client.state).toBe("closed");
    expect(order).toEqual(["notification-start:turn/completed"]);
    releaseNotification?.();
    await vi.waitFor(() => {
      expect(order).toEqual([
        "notification-start:turn/completed",
        "notification-end:turn/completed",
        "exit-published",
      ]);
    });
  });

  it("aborts a final notification before publishing an exit after drain timeout", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const order: string[] = [];
    let notificationSignal: AbortSignal | undefined;
    let releaseNotification: (() => void) | undefined;
    const notificationBarrier = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const client = createClient(transport, {
      notificationDrainTimeoutMs: 10,
      onNotification: async ({ method }, { signal }) => {
        notificationSignal = signal;
        order.push(`notification-start:${method}`);
        await notificationBarrier;
        if (signal.aborted) return;
        order.push(`notification-end:${method}`);
      },
      onError: () => {
        order.push("exit-published");
      },
    });
    await initializeClient(client, transport);

    transport.emitStdout('{"method":"turn/completed","params":{"status":"completed"}}');
    transport.emitExit({ code: 0, signal: null });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);

    expect(notificationSignal?.aborted).toBe(true);
    expect(order).toEqual([
      "notification-start:turn/completed",
      "exit-published",
    ]);
    releaseNotification?.();
    await flushPromises();
    expect(order).toEqual([
      "notification-start:turn/completed",
      "exit-published",
    ]);
  });

  it("correlates concurrent requests with reverse-order responses and notifications", async () => {
    const transport = new FakeTransport();
    const notifications: string[] = [];
    const client = createClient(transport, {
      onNotification: ({ method }) => {
        notifications.push(method);
      },
    });
    await initializeClient(client, transport);

    const threadRequest = client.request<{ thread: string }>("thread/read", { threadId: "t-1" });
    const turnRequest = client.request<{ turn: string }>("turn/steer", { threadId: "t-1" });

    expect(transport.messages().slice(-2)).toEqual([
      { id: 2, method: "thread/read", params: { threadId: "t-1" } },
      { id: 3, method: "turn/steer", params: { threadId: "t-1" } },
    ]);

    transport.emitStdout([
      JSON.stringify({ method: "item/started", params: { itemId: "i-1" } }),
      JSON.stringify({ id: 3, result: { turn: "steered" } }),
      JSON.stringify({ id: 2, result: { thread: "loaded" } }),
      "",
    ].join("\n"));

    await expect(turnRequest).resolves.toEqual({ turn: "steered" });
    await expect(threadRequest).resolves.toEqual({ thread: "loaded" });
    expect(notifications).toEqual(["item/started"]);
    expect(client.pendingRequestCount).toBe(0);
  });

  it("serializes async notification callbacks in wire order", async () => {
    const transport = new FakeTransport();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = createClient(transport, {
      onNotification: async ({ method }) => {
        order.push(`start:${method}`);
        if (method === "item/agentMessage/delta") await firstBarrier;
        order.push(`end:${method}`);
      },
    });
    await initializeClient(client, transport);

    transport.emitStdout([
      JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "before" } }),
      JSON.stringify({ method: "turn/completed", params: { status: "completed" } }),
      "",
    ].join("\n"));
    await flushPromises();

    expect(order).toEqual(["start:item/agentMessage/delta"]);
    releaseFirst?.();
    await vi.waitFor(() => {
      expect(order).toEqual([
        "start:item/agentMessage/delta",
        "end:item/agentMessage/delta",
        "start:turn/completed",
        "end:turn/completed",
      ]);
    });
  });

  it("aborts the active notification and skips queued notifications on client abort", async () => {
    const transport = new FakeTransport();
    const abortController = new AbortController();
    const started: string[] = [];
    const completed: string[] = [];
    let activeSawAbort = false;
    let releaseFirst: (() => void) | undefined;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = createClient(transport, {
      abortSignal: abortController.signal,
      onNotification: async ({ method }, { signal }) => {
        started.push(method);
        if (method === "item/agentMessage/delta") await firstBarrier;
        if (signal.aborted) {
          activeSawAbort = true;
          return;
        }
        completed.push(method);
      },
    });
    await initializeClient(client, transport);

    transport.emitStdout([
      JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "before" } }),
      JSON.stringify({ method: "turn/completed", params: { status: "completed" } }),
      "",
    ].join("\n"));
    await flushPromises();
    abortController.abort(new Error("operator stop"));
    releaseFirst?.();
    await flushPromises();

    expect(started).toEqual(["item/agentMessage/delta"]);
    expect(completed).toEqual([]);
    expect(activeSawAbort).toBe(true);
    expect(client.state).toBe("closed");
  });

  it("responds exactly once to successful, throwing, and timed-out server handlers", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    let resolveSlow: ((value: string) => void) | undefined;
    let slowSignal: AbortSignal | undefined;
    const client = createClient(transport, {
      serverRequestTimeoutMs: 25,
      serverRequestHandlers: {
        success: () => ({ accepted: true }),
        throws: () => {
          throw new Error("handler failed");
        },
        slow: ({ signal }) => {
          slowSignal = signal;
          return new Promise<string>((resolve) => {
            resolveSlow = resolve;
          });
        },
      },
    });
    await initializeClient(client, transport);

    transport.emitStdout([
      JSON.stringify({ id: "provider-1", method: "success" }),
      JSON.stringify({ id: "provider-2", method: "throws" }),
      JSON.stringify({ id: "provider-3", method: "slow" }),
      "",
    ].join("\n"));
    await flushPromises();

    expect(transport.messages().filter((message) => message.id === "provider-1")).toEqual([
      { id: "provider-1", result: { accepted: true } },
    ]);
    expect(transport.messages().filter((message) => message.id === "provider-2")).toEqual([
      { id: "provider-2", error: { code: -32603, message: "handler failed" } },
    ]);
    expect(transport.messages().filter((message) => message.id === "provider-3")).toEqual([]);

    await vi.advanceTimersByTimeAsync(25);

    expect(slowSignal?.aborted).toBe(true);
    expect(transport.messages().filter((message) => message.id === "provider-3")).toEqual([
      {
        id: "provider-3",
        error: { code: -32000, message: "Client handler timed out for slow" },
      },
    ]);

    resolveSlow?.("late result");
    await flushPromises();
    expect(transport.messages().filter((message) => message.id === "provider-3")).toHaveLength(1);
    expect(client.pendingServerRequestCount).toBe(0);
  });

  it("suppresses duplicate server request ids after the first response", async () => {
    const transport = new FakeTransport();
    const handler = vi.fn(() => ({ decision: "accept" }));
    const client = createClient(transport, {
      serverRequestHandlers: { approval: handler },
    });
    await initializeClient(client, transport);

    transport.emitMessage({ id: 44, method: "approval", params: { command: "pwd" } });
    await flushPromises();
    transport.emitMessage({ id: 44, method: "approval", params: { command: "pwd" } });
    await flushPromises();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(transport.messages().filter((message) => message.id === 44)).toEqual([
      { id: 44, result: { decision: "accept" } },
    ]);
  });

  it("does not re-execute the first server request after more than 1024 later ids", async () => {
    const transport = new FakeTransport();
    const handler = vi.fn(({ id }: { id: string | number }) => ({ id }));
    const client = createClient(transport, {
      serverRequestHandlers: { approval: handler },
    });
    await initializeClient(client, transport);

    for (let index = 0; index < 1_025; index += 1) {
      transport.emitMessage({ id: `provider-${index}`, method: "approval" });
    }
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1_025);
    });

    transport.emitMessage({ id: "provider-0", method: "approval" });
    await flushPromises();

    expect(handler).toHaveBeenCalledTimes(1_025);
    expect(transport.messages().filter((message) => message.id === "provider-0")).toEqual([
      { id: "provider-0", result: { id: "provider-0" } },
    ]);
  });

  it("fails closed when the server responds with an unknown request id", async () => {
    const transport = new FakeTransport();
    const client = createClient(transport);
    await initializeClient(client, transport);
    const pending = client.request("turn/steer", { threadId: "t-1" });

    transport.emitMessage({ id: 999, result: { turnId: "wrong" } });

    await expect(pending).rejects.toBeInstanceOf(CodexAppServerProtocolError);
    expect(client.state).toBe("failed");
    expect(client.protocolCompatible).toBe(false);
    expect(transport.terminated).toBe(true);
  });

  it("fails closed on a malformed RPC error response", async () => {
    const transport = new FakeTransport();
    const client = createClient(transport);
    await initializeClient(client, transport);
    const pending = client.request("turn/steer", { threadId: "t-1" });

    transport.emitMessage({ id: 2, error: {} });

    await expect(pending).rejects.toBeInstanceOf(CodexAppServerProtocolError);
    expect(client.state).toBe("failed");
    expect(client.protocolCompatible).toBe(false);
    expect(transport.terminated).toBe(true);
  });

  it("fails closed when an outbound transport write throws", async () => {
    const transport = new FakeTransport();
    const client = createClient(transport);
    await initializeClient(client, transport);
    transport.writeError = new Error("broken pipe");

    await expect(client.request("turn/steer", { threadId: "t-1" })).rejects.toThrow("broken pipe");

    expect(client.state).toBe("failed");
    expect(client.pendingRequestCount).toBe(0);
    expect(transport.terminated).toBe(true);
  });

  it("ignores a known late response after its request timed out", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = createClient(transport);
    await initializeClient(client, transport);
    const pending = client.request("thread/read", { threadId: "t-1" }, 10);
    const timedOut = expect(pending).rejects.toBeInstanceOf(CodexAppServerTimeoutError);

    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    transport.emitMessage({ id: 2, result: { threadId: "late" } });

    expect(client.state).toBe("ready");
    expect(client.protocolCompatible).toBe(true);
    expect(transport.terminated).toBe(false);
  });

  it.each([
    { id: null, method: "approval" },
    { id: { nested: true }, method: "approval" },
    { id: Number.MAX_SAFE_INTEGER + 1, method: "approval" },
    { id: 12, method: "approval", result: {} },
    { id: 12, result: {}, error: { code: -1, message: "both" } },
  ])("fails closed on a malformed RPC envelope: $id", async (message) => {
    const transport = new FakeTransport();
    const client = createClient(transport, {
      serverRequestHandlers: { approval: () => ({ accepted: true }) },
    });
    await initializeClient(client, transport);

    transport.emitMessage(message);

    expect(client.state).toBe("failed");
    expect(client.protocolCompatible).toBe(false);
    expect(transport.terminated).toBe(true);
  });

  it("fails closed on an unknown server method and rejects pending client work", async () => {
    const transport = new FakeTransport();
    const capabilityErrors: CodexAppServerProtocolError[] = [];
    const client = createClient(transport, {
      onCapabilityGateClosed: (error) => capabilityErrors.push(error),
    });
    await initializeClient(client, transport);
    const pending = client.request("thread/read", { threadId: "t-1" });

    transport.emitMessage({ id: "future-1", method: "future/request", params: {} });

    await expect(pending).rejects.toBeInstanceOf(CodexAppServerProtocolError);
    expect(transport.messages().filter((message) => message.id === "future-1")).toEqual([
      {
        id: "future-1",
        error: { code: -32601, message: "Client does not handle method \"future/request\"" },
      },
    ]);
    expect(client.state).toBe("failed");
    expect(client.protocolCompatible).toBe(false);
    expect(client.capabilityGateError).toBe(capabilityErrors[0]);
    expect(capabilityErrors).toHaveLength(1);
    expect(client.pendingRequestCount).toBe(0);
    expect(transport.terminated).toBe(true);
  });

  it("finishes fail-closed cleanup before running capability callbacks", async () => {
    const transport = new FakeTransport();
    const reportedErrors: Error[] = [];
    let stateDuringCallback: string | undefined;
    let reentrantRequest: Promise<unknown> | undefined;
    let client: CodexAppServerClient;
    client = createClient(transport, {
      onCapabilityGateClosed: () => {
        stateDuringCallback = client.state;
        reentrantRequest = client.request("thread/read", { threadId: "reentrant" });
        expect(() => client.notify("client/reentrant")).toThrow(CodexAppServerClosedError);
        throw new Error("callback failed");
      },
      onError: (error) => reportedErrors.push(error),
    });
    await initializeClient(client, transport);
    const pending = client.request("thread/read", { threadId: "pending" });

    transport.emitMessage({ id: "future-2", method: "future/request" });

    await expect(pending).rejects.toBeInstanceOf(CodexAppServerProtocolError);
    await expect(reentrantRequest).rejects.toBeInstanceOf(CodexAppServerClosedError);
    expect(stateDuringCallback).toBe("failed");
    expect(transport.terminated).toBe(true);
    expect(reportedErrors.some((error) => error.message === "callback failed")).toBe(true);
  });

  it("rejects outbound work and aborts inbound handlers when the process exits", async () => {
    const transport = new FakeTransport();
    let inboundSignal: AbortSignal | undefined;
    const client = createClient(transport, {
      serverRequestHandlers: {
        approval: ({ signal }) => {
          inboundSignal = signal;
          return new Promise(() => undefined);
        },
      },
    });
    await initializeClient(client, transport);
    const outbound = client.request("thread/read", { threadId: "t-1" });
    transport.emitMessage({ id: "approval-1", method: "approval" });
    await flushPromises();

    transport.emitExit({ code: 9, signal: null });

    await expect(outbound).rejects.toBeInstanceOf(CodexAppServerClosedError);
    expect(inboundSignal?.aborted).toBe(true);
    expect(client.state).toBe("closed");
    expect(client.pendingRequestCount).toBe(0);
    expect(client.pendingServerRequestCount).toBe(0);
    expect(transport.messages().filter((message) => message.id === "approval-1")).toEqual([]);
    expect(transport.terminated).toBe(false);
  });

  it("terminates transport and clears both request directions when aborted", async () => {
    const transport = new FakeTransport();
    const abortController = new AbortController();
    let inboundSignal: AbortSignal | undefined;
    const client = createClient(transport, {
      abortSignal: abortController.signal,
      serverRequestHandlers: {
        approval: ({ signal }) => {
          inboundSignal = signal;
          return new Promise(() => undefined);
        },
      },
    });
    await initializeClient(client, transport);
    const outbound = client.request("turn/start", { threadId: "t-1" });
    transport.emitMessage({ id: "approval-2", method: "approval" });
    await flushPromises();

    abortController.abort(new Error("operator stop"));

    await expect(outbound).rejects.toThrow("operator stop");
    expect(inboundSignal?.aborted).toBe(true);
    expect(transport.messages().filter((message) => message.id === "approval-2")).toEqual([
      { id: "approval-2", error: { code: -32603, message: "operator stop" } },
    ]);
    expect(client.state).toBe("closed");
    expect(client.pendingRequestCount).toBe(0);
    expect(client.pendingServerRequestCount).toBe(0);
    expect(transport.terminated).toBe(true);
  });

  it("blocks request and notification reentry from an inbound abort listener", async () => {
    const transport = new FakeTransport();
    const abortController = new AbortController();
    let stateDuringAbort: string | undefined;
    let reentrantRequest: Promise<unknown> | undefined;
    let notifyError: unknown;
    let client: CodexAppServerClient;
    client = createClient(transport, {
      abortSignal: abortController.signal,
      serverRequestHandlers: {
        approval: ({ signal }) => new Promise(() => {
          signal.addEventListener("abort", () => {
            stateDuringAbort = client.state;
            reentrantRequest = client.request("thread/read", { threadId: "reentrant" });
            try {
              client.notify("client/reentrant");
            } catch (error) {
              notifyError = error;
            }
          }, { once: true });
        }),
      },
    });
    await initializeClient(client, transport);
    transport.emitMessage({ id: "approval-reentrant", method: "approval" });
    await flushPromises();

    abortController.abort(new Error("operator stop"));

    await expect(reentrantRequest).rejects.toBeInstanceOf(CodexAppServerClosedError);
    expect(stateDuringAbort).toBe("closed");
    expect(notifyError).toBeInstanceOf(CodexAppServerClosedError);
    expect(transport.messages().some((message) => message.method === "client/reentrant")).toBe(false);
    expect(transport.terminated).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { runDesktopCliMode } from "./cli-runner.js";

type TestWritable = {
  writable: boolean;
  destroyed: boolean;
  callbacks: Array<(error?: Error | null) => void>;
  listeners: Set<(error: Error) => void>;
  onceListeners: Map<(error: Error) => void, (error: Error) => void>;
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  emitError(error: Error): void;
};

function createDelayedWritable(options: { throwOnWrite?: Error } = {}): TestWritable {
  const stream: TestWritable = {
    writable: true,
    destroyed: false,
    callbacks: [],
    listeners: new Set(),
    onceListeners: new Map(),
    write: (_chunk, callback) => {
      if (options.throwOnWrite) throw options.throwOnWrite;
      if (callback) stream.callbacks.push(callback);
      return true;
    },
    on: (_event, listener) => {
      stream.listeners.add(listener);
    },
    once: (_event, listener) => {
      const wrapped = (error: Error) => {
        stream.listeners.delete(wrapped);
        stream.onceListeners.delete(listener);
        listener(error);
      };
      stream.onceListeners.set(listener, wrapped);
      stream.listeners.add(wrapped);
    },
    off: (_event, listener) => {
      stream.listeners.delete(listener);
      const wrapped = stream.onceListeners.get(listener);
      if (wrapped) {
        stream.listeners.delete(wrapped);
        stream.onceListeners.delete(listener);
      }
    },
    emitError: (error) => {
      if (stream.listeners.size === 0) throw error;
      for (const listener of [...stream.listeners]) listener(error);
    },
  };
  return stream;
}

function createBrokenPipeError(message = "write EPIPE"): Error {
  return Object.assign(new Error(message), { code: "EPIPE" });
}

async function waitForMicrotasksUntil(assertion: () => boolean): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    if (assertion()) return;
    await Promise.resolve();
  }
}

describe("runDesktopCliMode", () => {
  it("waits for stdout and stderr to flush before exiting the Desktop shim", async () => {
    const stdout = createDelayedWritable();
    const stderr = createDelayedWritable();
    const exits: number[] = [];

    const run = runDesktopCliMode({
      argv: [process.execPath, "rudder", "agent", "me", "--json"],
      importCliModule: async () => ({
        runCli: async () => 0,
      }),
      exit: (exitCode) => {
        exits.push(exitCode);
      },
      stdout,
      stderr,
    });

    await waitForMicrotasksUntil(() => stdout.callbacks.length === 1 && stderr.callbacks.length === 1);
    expect(exits).toEqual([]);
    expect(stdout.callbacks).toHaveLength(1);
    expect(stderr.callbacks).toHaveLength(1);

    stdout.callbacks[0]?.();
    await Promise.resolve();
    expect(exits).toEqual([]);

    stderr.callbacks[0]?.();
    await run;
    expect(exits).toEqual([0]);
  });

  it("keeps exiting successfully when an output stream reports a late broken pipe", async () => {
    const stdout = createDelayedWritable();
    const stderr = createDelayedWritable();
    const exits: number[] = [];
    const logs: unknown[][] = [];

    const run = runDesktopCliMode({
      argv: [process.execPath, "rudder", "start", "--desktop-progress-json"],
      importCliModule: async () => ({
        runCli: async () => 0,
      }),
      exit: (exitCode) => {
        exits.push(exitCode);
      },
      stdout,
      stderr,
      logError: (...args) => logs.push(args),
    });

    await waitForMicrotasksUntil(() => stdout.callbacks.length === 1 && stderr.callbacks.length === 1);
    stdout.callbacks[0]?.();
    stdout.emitError(createBrokenPipeError());
    stderr.callbacks[0]?.();

    await run;
    expect(exits).toEqual([0]);
    expect(logs).toEqual([]);
  });

  it("treats a broken pipe thrown while flushing as a clean shutdown", async () => {
    const stdout = createDelayedWritable({ throwOnWrite: createBrokenPipeError() });
    const stderr = createDelayedWritable();
    const exits: number[] = [];

    const run = runDesktopCliMode({
      argv: [process.execPath, "rudder", "start", "--desktop-progress-json"],
      importCliModule: async () => ({
        runCli: async () => 0,
      }),
      exit: (exitCode) => {
        exits.push(exitCode);
      },
      stdout,
      stderr,
    });

    await waitForMicrotasksUntil(() => stderr.callbacks.length === 1);
    stderr.callbacks[0]?.();

    await run;
    expect(exits).toEqual([0]);
  });
});

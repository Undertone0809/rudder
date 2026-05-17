import { describe, expect, it } from "vitest";
import { runDesktopCliMode } from "./cli-runner.js";

type TestWritable = {
  writable: boolean;
  destroyed: boolean;
  callbacks: Array<(error?: Error | null) => void>;
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
};

function createDelayedWritable(): TestWritable {
  const stream: TestWritable = {
    writable: true,
    destroyed: false,
    callbacks: [],
    write: (_chunk, callback) => {
      if (callback) stream.callbacks.push(callback);
      return true;
    },
  };
  return stream;
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
});

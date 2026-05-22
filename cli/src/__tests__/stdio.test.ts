import { describe, expect, it } from "vitest";
import { flushProcessOutputBeforeExit, flushWritableStream, type WritableLike } from "../stdio.js";

function createDelayedWritable() {
  const callbacks: Array<(error?: Error | null) => void> = [];
  const stream: WritableLike = {
    writable: true,
    destroyed: false,
    write: (_chunk, callback) => {
      if (callback) callbacks.push(callback);
      return true;
    },
  };
  return { callbacks, stream };
}

describe("stdio flushing", () => {
  it("waits for an async write callback even when the stream has no backpressure", async () => {
    const { callbacks, stream } = createDelayedWritable();
    let resolved = false;

    const flush = flushWritableStream(stream).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(callbacks).toHaveLength(1);

    callbacks[0]?.();
    await flush;
    expect(resolved).toBe(true);
  });

  it("flushes stdout and stderr before the CLI exits", async () => {
    const stdout = createDelayedWritable();
    const stderr = createDelayedWritable();
    let resolved = false;

    const flush = flushProcessOutputBeforeExit({
      stdout: stdout.stream,
      stderr: stderr.stream,
    }).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(stdout.callbacks).toHaveLength(1);
    expect(stderr.callbacks).toHaveLength(1);

    stdout.callbacks[0]?.();
    await Promise.resolve();
    expect(resolved).toBe(false);

    stderr.callbacks[0]?.();
    await flush;
    expect(resolved).toBe(true);
  });
});

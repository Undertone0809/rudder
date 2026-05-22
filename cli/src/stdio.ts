export type WritableLike = {
  writable?: boolean;
  destroyed?: boolean;
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  once?(event: "error", listener: (error: Error) => void): unknown;
  off?(event: "error", listener: (error: Error) => void): unknown;
};

export async function flushWritableStream(stream: WritableLike): Promise<void> {
  if (stream.destroyed || stream.writable === false) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.off?.("error", onError);
    };
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error && !isBrokenPipeError(error)) reject(error);
      else resolve();
    };
    const onError = (error: Error) => {
      finish(error);
    };

    stream.once?.("error", onError);

    try {
      stream.write("", finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function flushProcessOutputBeforeExit(
  streams: { stdout?: WritableLike; stderr?: WritableLike } = {},
): Promise<void> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  await Promise.all([
    flushWritableStream(stdout),
    flushWritableStream(stderr),
  ]);
}

function isBrokenPipeError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "EPIPE";
}

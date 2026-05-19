export type DesktopCliModule = {
  runCli(argv?: string[]): Promise<number>;
};

type WritableLike = {
  writable?: boolean;
  destroyed?: boolean;
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  on?(event: "error", listener: (error: Error) => void): unknown;
  once?(event: "error", listener: (error: Error) => void): unknown;
  off?(event: "error", listener: (error: Error) => void): unknown;
};

type RunDesktopCliModeOptions = {
  argv: string[];
  importCliModule(): Promise<DesktopCliModule>;
  exit(exitCode: number): void;
  stdout?: WritableLike;
  stderr?: WritableLike;
  logError?: (...args: unknown[]) => void;
};

export async function runDesktopCliMode(options: RunDesktopCliModeOptions): Promise<void> {
  let exitCode = 1;
  const logError = options.logError ?? console.error;
  installBrokenPipeGuards({
    stdout: options.stdout,
    stderr: options.stderr,
  }, logError);

  try {
    const cliModule = await options.importCliModule();
    exitCode = await cliModule.runCli(options.argv);
  } catch (error) {
    logError("[rudder-desktop] failed to run desktop CLI mode", error);
  }

  try {
    // Desktop CLI mode exits via Electron's app.exit(), so it must flush the
    // Electron process pipes here instead of relying on the npm CLI entrypoint.
    await flushProcessOutputBeforeExit({
      stdout: options.stdout,
      stderr: options.stderr,
    });
  } catch (error) {
    logError("[rudder-desktop] failed to flush desktop CLI output", error);
    if (exitCode === 0) exitCode = 1;
  }

  options.exit(exitCode);
}

async function flushProcessOutputBeforeExit(
  streams: { stdout?: WritableLike; stderr?: WritableLike } = {},
): Promise<void> {
  await Promise.all([
    flushWritableStream(streams.stdout ?? process.stdout),
    flushWritableStream(streams.stderr ?? process.stderr),
  ]);
}

async function flushWritableStream(stream: WritableLike): Promise<void> {
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

function isBrokenPipeError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return true;
  const message = error.message.toLowerCase();
  return message.includes("epipe") || message.includes("broken pipe");
}

function installBrokenPipeGuards(
  streams: { stdout?: WritableLike; stderr?: WritableLike },
  logError: (...args: unknown[]) => void,
): void {
  const outputStreams: WritableLike[] = [
    streams.stdout ?? process.stdout,
    streams.stderr ?? process.stderr,
  ];
  for (const stream of outputStreams) {
    stream.on?.("error", (error: Error) => {
      if (isBrokenPipeError(error)) return;
      try {
        logError("[rudder-desktop] desktop CLI output stream error", error);
      } catch {
        // Logging must not become another shutdown-time stream failure.
      }
    });
  }
}

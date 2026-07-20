import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePostgresDatabase } from "../../packages/db/src/index.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function availablePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate an isolated PostgreSQL port.")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function run() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "rudder-control-plane-perf-"));
  const port = await availablePort();
  const postgresDiagnostics: string[] = [];
  const recordPostgresDiagnostic = (message: unknown) => {
    const formatted = typeof message === "string" ? message : JSON.stringify(message);
    postgresDiagnostics.push(formatted);
    if (postgresDiagnostics.length > 100) postgresDiagnostics.shift();
  };
  const module = await import("../../packages/db/node_modules/embedded-postgres/dist/index.js");
  const EmbeddedPostgres = module.default as EmbeddedPostgresCtor;
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: recordPostgresDiagnostic,
    onError: recordPostgresDiagnostic,
  });

  try {
    try {
      await instance.initialise();
      await instance.start();
    } catch (error) {
      console.error("Embedded PostgreSQL failed to start. Recent diagnostics:");
      console.error(postgresDiagnostics.join("\n"));
      throw error;
    }
    const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "rudder");
    const databaseUrl = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const child = spawn(
      process.execPath,
      [
        "cli/node_modules/tsx/dist/cli.mjs",
        "scripts/perf/control-plane-baseline.ts",
        ...process.argv.slice(2),
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "inherit",
      },
    );
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`Benchmark terminated by ${signal}.`));
          return;
        }
        resolve(code ?? 1);
      });
    });
    process.exitCode = exitCode;
  } finally {
    await instance.stop().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await run();

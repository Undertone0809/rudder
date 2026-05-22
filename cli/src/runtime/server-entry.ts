import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ensureRuntimeInstalled,
  importRuntimeServerModule,
  type EnsureRuntimeInstalledOptions,
} from "./install.js";

export interface StartedServer {
  apiUrl: string;
  databaseUrl: string | null;
  host: string;
  listenPort: number;
  runtime: {
    mode: "owned" | "attached";
    instanceId: string;
    localEnv: string | null;
    ownerKind: string | null;
    version: string;
  };
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface LoadServerRuntimeOptions {
  version: string;
  homeDir?: string;
  onRuntimeInstalled?: (result: Awaited<ReturnType<typeof ensureRuntimeInstalled>>) => void;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message && err.message.trim().length > 0) return err.message;
    return err.name;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function maybeEnableUiDevMiddleware(entrypoint: string): void {
  if (process.env.RUDDER_UI_DEV_MIDDLEWARE !== undefined) return;
  const normalized = entrypoint.replaceAll("\\", "/");
  if (normalized.endsWith("/server/src/index.ts") || normalized.endsWith("@rudderhq/server/src/index.ts")) {
    process.env.RUDDER_UI_DEV_MIDDLEWARE = "true";
  }
}

function resolveDevServerEntry(): string {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  return path.resolve(projectRoot, "server/src/index.ts");
}

export async function loadServerRuntimeModule(options: LoadServerRuntimeOptions): Promise<unknown> {
  const devEntry = resolveDevServerEntry();
  if (fs.existsSync(devEntry)) {
    maybeEnableUiDevMiddleware(devEntry);
    return await import(pathToFileURL(devEntry).href);
  }

  const installOptions: EnsureRuntimeInstalledOptions = {
    version: options.version,
    homeDir: options.homeDir,
  };
  const runtime = await ensureRuntimeInstalled(installOptions);
  options.onRuntimeInstalled?.(runtime);
  return await importRuntimeServerModule(runtime.cacheDir);
}

export async function startManagedServerFromRuntime(
  options: LoadServerRuntimeOptions,
): Promise<StartedServer> {
  try {
    const mod = await loadServerRuntimeModule(options);
    return await startServerFromModule(mod);
  } catch (err) {
    throw new Error(`Rudder server failed to start.\n${formatError(err)}`);
  }
}

async function startServerFromModule(mod: unknown): Promise<StartedServer> {
  const startManagedLocalServer = (mod as {
    startManagedLocalServer?: (options: {
      ownerKind: "cli";
      takeoverOnVersionMismatch?: boolean;
    }) => Promise<StartedServer>;
  }).startManagedLocalServer;
  if (typeof startManagedLocalServer !== "function") {
    throw new Error("Rudder server runtime did not export startManagedLocalServer().");
  }
  return await startManagedLocalServer({
    ownerKind: "cli",
    takeoverOnVersionMismatch: true,
  });
}

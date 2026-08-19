import { resolveNativeCommand } from "@rudderhq/agent-runtime-utils";
import { resolveRudderNativeCapability, resolveRudderNativeTarget, type RudderNativeDiagnostic } from "@rudderhq/shared";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveRudderInstanceRoot } from "../home-paths.js";

const PROTOCOL_VERSION = 1;
const MAX_ENTRIES = 1_000_000;
const MAX_PATH_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;
const DEBOUNCE_MS = 100;
const REQUIRED_READY_TIMEOUT_MS = 5_000;

export type NativeWorkspaceManifestEntry = {
  path: string;
  kind: "file" | "directory" | "symlink";
  byteSize: number;
  modifiedMillis: number;
};

type WatchState = "building" | "ready" | "dirty" | "overflow" | "unavailable" | "stopped";
type WatchSession = {
  child: ChildProcessWithoutNullStreams;
  manifestPath: string;
  state: WatchState;
  exited: boolean;
  target: string;
  binaryVersion: string;
};

const sessions = new Map<string, WatchSession>();

class NativeWorkspaceManifestError extends Error {
  readonly diagnostic: RudderNativeDiagnostic;

  constructor(session: WatchSession, code: string, detail: string) {
    super(detail);
    this.name = "NativeWorkspaceManifestError";
    this.diagnostic = {
      capability: "workspace-manifest",
      target: session.target,
      binaryVersion: session.binaryVersion,
      protocolVersion: String(PROTOCOL_VERSION),
      effectiveEngine: "rust",
      fallbackCode: code,
    };
  }
}

function nativeTarget() {
  return resolveRudderNativeTarget();
}

export function resolveNativeWorkspaceManifestBinary() {
  const configured = process.env.RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH?.trim()
    || process.env.RUDDER_NATIVE_PATH?.trim();
  if (configured) return path.resolve(configured);
  const binaryName = process.platform === "win32" ? "rudder-native.exe" : "rudder-native";
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const target = nativeTarget();
  const resourcesPath = process.env.RUDDER_DESKTOP_RESOURCES_PATH?.trim()
    || (typeof (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath: string }).resourcesPath
      : "");
  const candidates = [
    path.resolve(moduleDir, "../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../native", target ?? "unsupported", binaryName),
    resourcesPath && target ? path.resolve(resourcesPath, "native", target, binaryName) : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function manifestPathForRoot(rootPath: string) {
  const key = createHash("sha256").update(path.resolve(rootPath)).digest("hex").slice(0, 24);
  return path.resolve(resolveRudderInstanceRoot(), "data", "native-workspace-manifests", `${key}.json`);
}

function watchState(value: unknown): WatchState | null {
  return ["building", "ready", "dirty", "overflow", "unavailable", "stopped"].includes(String(value))
    ? value as WatchState
    : null;
}

async function startSession(rootPath: string): Promise<WatchSession> {
  const manifestPath = manifestPathForRoot(rootPath);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const command = resolveNativeCommand(resolveNativeWorkspaceManifestBinary(), [
    "workspace", "watch", path.resolve(rootPath), manifestPath,
    String(MAX_ENTRIES), String(MAX_PATH_BYTES), String(DEBOUNCE_MS),
  ]);
  const child = spawn(command.command, command.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const session: WatchSession = {
    child, manifestPath, state: "building", exited: false,
    target: nativeTarget() ?? "unsupported", binaryVersion: "unavailable",
  };
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const envelope = JSON.parse(line) as Record<string, unknown>;
      const state = watchState(envelope.state);
      if (envelope.ok !== true || envelope.capability !== "workspace.watch"
        || envelope.protocolVersion !== PROTOCOL_VERSION || !state) {
        session.state = "unavailable";
        return;
      }
      if (typeof envelope.target === "string") session.target = envelope.target;
      if (typeof envelope.binaryVersion === "string") session.binaryVersion = envelope.binaryVersion;
      session.state = state;
    } catch {
      session.state = "unavailable";
    }
  });
  child.once("error", () => {
    session.state = "unavailable";
    session.exited = true;
  });
  child.once("exit", () => {
    if (session.state !== "stopped") session.state = "unavailable";
    session.exited = true;
  });
  child.stderr.resume();
  return session;
}

async function ensureSession(rootPath: string) {
  const key = path.resolve(rootPath);
  const existing = sessions.get(key);
  if (existing && !existing.exited) return existing;
  const session = await startSession(key);
  sessions.set(key, session);
  return session;
}

async function waitForRequiredReady(session: WatchSession) {
  const deadline = Date.now() + REQUIRED_READY_TIMEOUT_MS;
  while (session.state !== "ready") {
    if (session.state === "unavailable" || session.exited) {
      throw new NativeWorkspaceManifestError(session, "watch_unavailable", "Native workspace manifest watcher is unavailable");
    }
    if (Date.now() >= deadline) {
      throw new NativeWorkspaceManifestError(session, "ready_timeout", `Native workspace manifest watcher did not become ready within ${REQUIRED_READY_TIMEOUT_MS}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function parseManifest(value: unknown, rootPath: string): NativeWorkspaceManifestEntry[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.protocolVersion !== PROTOCOL_VERSION || manifest.state !== "ready"
    || path.resolve(String(manifest.rootPath ?? "")) !== path.resolve(rootPath)
    || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_ENTRIES) return null;
  const entries: NativeWorkspaceManifestEntry[] = [];
  let pathBytes = 0;
  for (const value of manifest.entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    const entryPath = typeof entry.path === "string" ? entry.path : "";
    const kind = entry.kind;
    if (!entryPath || entryPath.includes("\\") || entryPath.startsWith("/")
      || entryPath.split("/").some((part) => !part || part === "." || part === "..")
      || !["file", "directory", "symlink"].includes(String(kind))
      || !Number.isSafeInteger(entry.byteSize) || Number(entry.byteSize) < 0
      || !Number.isSafeInteger(entry.modifiedMillis) || Number(entry.modifiedMillis) < 0) return null;
    pathBytes += Buffer.byteLength(entryPath);
    if (pathBytes > MAX_PATH_BYTES) return null;
    entries.push({
      path: entryPath,
      kind: kind as NativeWorkspaceManifestEntry["kind"],
      byteSize: Number(entry.byteSize),
      modifiedMillis: Number(entry.modifiedMillis),
    });
  }
  return entries;
}

export async function readNativeWorkspaceManifest(rootPath: string): Promise<NativeWorkspaceManifestEntry[] | null> {
  const policy = resolveRudderNativeCapability({ capability: "workspace-manifest", env: process.env });
  if (!policy.enabled) return null;
  let session: WatchSession;
  try {
    session = await ensureSession(rootPath);
  } catch (error) {
    if (policy.required) throw error;
    return null;
  }
  if (policy.required) await waitForRequiredReady(session);
  if (session.state !== "ready") {
    return null;
  }
  try {
    const stat = await fs.stat(session.manifestPath);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error("Native workspace manifest exceeds its read boundary");
    const entries = parseManifest(JSON.parse(await fs.readFile(session.manifestPath, "utf8")), rootPath);
    if (!entries) throw new Error("Native workspace manifest is invalid");
    return entries;
  } catch (error) {
    await fs.rm(session.manifestPath, { force: true }).catch(() => undefined);
    session.state = "dirty";
    if (policy.required) {
      throw new NativeWorkspaceManifestError(
        session,
        "invalid_manifest",
        error instanceof Error ? error.message : "Native workspace manifest is invalid",
      );
    }
    return null;
  }
}

export async function stopNativeWorkspaceManifestWatchersForTests() {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.all(active.map(async (session) => {
    if (session.exited) return;
    session.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        session.child.kill();
        resolve();
      }, 1_000);
      session.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }));
}

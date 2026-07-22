import { access, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { LocalAppDefinitionDraft } from "./local-apps-registry.js";

const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_README_BYTES = 128 * 1024;
const SUPPORTED_SCRIPTS = ["dev", "start", "serve", "preview"] as const;

type PackageMetadata = {
  name?: unknown;
  scripts?: unknown;
  rudder?: unknown;
};

async function readBoundedFile(file: FileHandle, maxBytes: number, tooLargeMessage: string): Promise<string> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead > maxBytes) throw new Error(tooLargeMessage);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function inferPackageManager(root: string): Promise<string> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  if (await exists(path.join(root, "yarn.lock"))) return process.platform === "win32" ? "yarn.cmd" : "yarn";
  if (await exists(path.join(root, "bun.lock")) || await exists(path.join(root, "bun.lockb"))) {
    return process.platform === "win32" ? "bun.exe" : "bun";
  }
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function readBoundedReadme(root: string): Promise<string | null> {
  const readmePath = path.join(root, "README.md");
  let file: FileHandle | undefined;
  try {
    file = await open(readmePath, "r");
    const readmeStats = await file.stat();
    if (!readmeStats.isFile() || readmeStats.size > MAX_README_BYTES) return null;
    return await readBoundedFile(file, MAX_README_BYTES, "README.md is too large");
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function safeDocumentedRoute(value: string | undefined): string | null {
  if (!value || value.length > 256 || !/^\/[A-Za-z0-9._~/-]*$/.test(value) || value.includes("//")) return null;
  return value;
}

function inferDocumentedRoutes(readme: string | null): { readinessPath: string | null; openPath: string | null } {
  if (!readme) return { readinessPath: null, openPath: null };
  const openMatch = /\bOpen[^\r\n]{0,160}\bat\s+`(\/[A-Za-z0-9._~/-]*)`/i.exec(readme);
  const healthMatch = /`GET\s+(\/[A-Za-z0-9._~/-]*health[A-Za-z0-9._~/-]*)`/i.exec(readme);
  return {
    readinessPath: safeDocumentedRoute(healthMatch?.[1]),
    openPath: safeDocumentedRoute(openMatch?.[1]),
  };
}

function optionalRoute(value: unknown, fallback: string): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && value.length <= 2_048
    ? value
    : fallback;
}

function optionalTimeout(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 250 && Number(value) <= 120_000
    ? Number(value)
    : 30_000;
}

export async function discoverLocalAppDefinition(
  selectedRoot: string,
  // Reserved for dependency injection in callers; discovery deliberately never spawns.
  _options: { spawn?: unknown } = {},
): Promise<LocalAppDefinitionDraft> {
  const root = await realpath(selectedRoot);
  const packagePath = path.join(root, "package.json");
  let metadata: PackageMetadata;
  const packageFile = await open(packagePath, "r");
  try {
    const packageStats = await packageFile.stat();
    if (!packageStats.isFile()) throw new Error("Selected folder has no package.json file");
    if (packageStats.size > MAX_PACKAGE_JSON_BYTES) throw new Error("package.json is too large to inspect safely");
    metadata = JSON.parse(await readBoundedFile(
      packageFile,
      MAX_PACKAGE_JSON_BYTES,
      "package.json is too large to inspect safely",
    )) as PackageMetadata;
  } catch (error) {
    if (error instanceof Error && (error.message.includes("too large") || error.message.includes("no package.json"))) {
      throw error;
    }
    throw new Error("Selected folder does not contain a valid package.json");
  } finally {
    await packageFile.close();
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Selected folder does not contain a valid package.json");
  }

  const scripts = metadata.scripts && typeof metadata.scripts === "object" && !Array.isArray(metadata.scripts)
    ? metadata.scripts as Record<string, unknown>
    : {};
  const scriptName = SUPPORTED_SCRIPTS.find((candidate) => typeof scripts[candidate] === "string" && scripts[candidate].trim().length > 0);
  if (!scriptName) throw new Error("package.json has no supported development script");

  const rudder = metadata.rudder && typeof metadata.rudder === "object" && !Array.isArray(metadata.rudder)
    ? metadata.rudder as Record<string, unknown>
    : {};
  const readiness = rudder.readiness && typeof rudder.readiness === "object" && !Array.isArray(rudder.readiness)
    ? rudder.readiness as Record<string, unknown>
    : {};
  const documented = inferDocumentedRoutes(await readBoundedReadme(root));

  return {
    title: typeof metadata.name === "string" && metadata.name.trim().length > 0
      ? metadata.name.trim().slice(0, 200)
      : path.basename(root),
    executable: await inferPackageManager(root),
    argv: ["run", scriptName],
    cwd: root,
    inheritedEnvNames: [],
    readiness: {
      path: optionalRoute(readiness.path, documented.readinessPath ?? "/api/health"),
      timeoutMs: optionalTimeout(readiness.timeoutMs),
    },
    openPath: optionalRoute(rudder.openPath, documented.openPath ?? "/"),
  };
}

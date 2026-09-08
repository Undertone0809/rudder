import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveNpmCommandInvocation } from "../npm-command.js";

const NPM_PUBLIC_REGISTRY_URL = "https://registry.npmjs.org";
const NPM_PLATFORM_REPAIR_ENV = {
  npm_config_registry: NPM_PUBLIC_REGISTRY_URL,
  npm_config_update_notifier: "false",
  NO_UPDATE_NOTIFIER: "1",
};

export type SpawnSyncResultLike = ReturnType<typeof spawnSync>;

export type PackageJsonLike = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type RuntimePackageDeadline<T> = {
  deadline?: T;
  cacheDir: string;
  remainingMs: (deadline: T | undefined, cacheDir: string, command: string) => number | undefined;
};

export function runtimePackageJsonPath(cacheDir: string, packageName: string): string {
  return path.join(cacheDir, "node_modules", ...packageName.split("/"), "package.json");
}

export async function readRuntimePackageJson(cacheDir: string, packageName: string): Promise<PackageJsonLike | null> {
  try {
    return JSON.parse(await readFile(runtimePackageJsonPath(cacheDir, packageName), "utf8")) as PackageJsonLike;
  } catch {
    return null;
  }
}

export async function canResolveRuntimePackage(cacheDir: string, packageName: string): Promise<boolean> {
  try {
    await readFile(runtimePackageJsonPath(cacheDir, packageName), "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function removeRuntimeInstallLocks(cacheDir: string): Promise<void> {
  await Promise.all([
    rm(path.join(cacheDir, "package-lock.json"), { force: true }),
    rm(path.join(cacheDir, "node_modules", ".package-lock.json"), { force: true }),
  ]);
}

export function packageNameFromSpec(packageSpec: string): string {
  if (!packageSpec.startsWith("@")) {
    const versionSeparator = packageSpec.indexOf("@");
    return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
  }

  const versionSeparator = packageSpec.indexOf("@", 1);
  return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
}

export function normalizeOptionalDependencyVersion(versionRange: string | undefined): string | null {
  const trimmed = versionRange?.trim();
  if (!trimmed) return null;
  const exactVersion = /^[~^]\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/.exec(trimmed);
  return exactVersion?.[1] ?? trimmed;
}

export async function installRuntimePackageInStaging<TDeadline>(
  spawnSyncImpl: typeof spawnSync,
  cacheDir: string,
  packageSpec: string,
  packageName: string,
  options: RuntimePackageDeadline<TDeadline>,
): Promise<SpawnSyncResultLike> {
  const stagingDir = path.join(cacheDir, `.platform-repair-${process.pid}-${Date.now()}`);
  await mkdir(stagingDir, { recursive: true });

  try {
    const packResult = runNpmPack(spawnSyncImpl, packageSpec, stagingDir, options);
    if (packResult.status !== 0) return packResult;

    const packFilename = parseNpmPackFilename(packResult.stdout);
    if (!packFilename) {
      return createSyntheticSpawnResult(1, "", `Unable to parse npm pack output for ${packageSpec}.`);
    }

    const archivePath = path.join(stagingDir, packFilename);
    const targetDir = path.dirname(runtimePackageJsonPath(cacheDir, packageName));
    await mkdir(path.dirname(targetDir), { recursive: true });
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });

    const extractResult = runTarExtract(spawnSyncImpl, archivePath, targetDir, options);
    return combineSpawnResults(packResult, extractResult);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function runNpmPack<TDeadline>(
  spawnSyncImpl: typeof spawnSync,
  packageSpec: string,
  destinationDir: string,
  options: RuntimePackageDeadline<TDeadline>,
): SpawnSyncResultLike {
  const timeout = options.remainingMs(options.deadline, options.cacheDir, `npm pack ${packageSpec}`);
  const npm = resolveNpmCommandInvocation();
  return spawnSyncImpl(
    npm.command,
    [
      ...npm.args,
      "pack",
      packageSpec,
      "--pack-destination",
      destinationDir,
      "--registry",
      NPM_PUBLIC_REGISTRY_URL,
      "--silent",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...NPM_PLATFORM_REPAIR_ENV },
      ...(timeout === undefined ? {} : { timeout }),
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    },
  );
}

function runTarExtract<TDeadline>(
  spawnSyncImpl: typeof spawnSync,
  archivePath: string,
  targetDir: string,
  options: RuntimePackageDeadline<TDeadline>,
): SpawnSyncResultLike {
  const timeout = options.remainingMs(options.deadline, options.cacheDir, "extract runtime platform package");
  return spawnSyncImpl(
    "tar",
    ["-xzf", archivePath, "-C", targetDir, "--strip-components", "1"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(timeout === undefined ? {} : { timeout }),
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    },
  );
}

function parseNpmPackFilename(stdout: unknown): string | null {
  if (typeof stdout !== "string") return null;
  const filename = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return filename?.endsWith(".tgz") ? filename : null;
}

function createSyntheticSpawnResult(status: number, stdout: string, stderr: string): SpawnSyncResultLike {
  return { status, stdout, stderr } as SpawnSyncResultLike;
}

function combineSpawnResults(...results: SpawnSyncResultLike[]): SpawnSyncResultLike {
  const last = results.at(-1);
  return {
    status: last?.status ?? 0,
    stdout: results.map((result) => result.stdout).filter(Boolean).join("\n"),
    stderr: results.map((result) => result.stderr).filter(Boolean).join("\n"),
    error: results.find((result) => result.error)?.error,
  } as SpawnSyncResultLike;
}

function isLinuxGlibcRuntime(): boolean {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
    return typeof report.header?.glibcVersionRuntime === "string";
  } catch {
    return true;
  }
}

function resolveSharpPlatformPackageName(sharpPackage: PackageJsonLike): string | null {
  const platformPrefixes = process.platform === "linux"
    ? [
        isLinuxGlibcRuntime() ? "linux" : "linuxmusl",
        "linux",
        "linuxmusl",
      ]
    : [process.platform];
  for (const platformPrefix of platformPrefixes) {
    const packageName = `@img/sharp-${platformPrefix}-${process.arch}`;
    if (sharpPackage.optionalDependencies?.[packageName]) return packageName;
  }
  return null;
}

export async function hasRequiredRuntimeNativeDependencies(cacheDir: string): Promise<boolean> {
  const sharpPackage = await readRuntimePackageJson(cacheDir, "sharp");
  if (!sharpPackage) return true;
  const platformPackageName = resolveSharpPlatformPackageName(sharpPackage);
  if (!platformPackageName) return true;

  const requiredPackages = [{
    name: platformPackageName,
    version: normalizeOptionalDependencyVersion(sharpPackage.optionalDependencies?.[platformPackageName]),
  }];
  for (let index = 0; index < requiredPackages.length; index += 1) {
    const requiredPackage = requiredPackages[index];
    const packageJson = await readRuntimePackageJson(cacheDir, requiredPackage.name);
    if (!packageJson || (
      requiredPackage.version !== null
      && packageJson.version !== requiredPackage.version
    )) return false;
    for (const [dependencyName, versionRange] of Object.entries(packageJson.optionalDependencies ?? {})) {
      if (!requiredPackages.some(({ name }) => name === dependencyName)) {
        requiredPackages.push({
          name: dependencyName,
          version: normalizeOptionalDependencyVersion(versionRange),
        });
      }
    }
  }
  return true;
}

export async function ensureRuntimeNativeDependencies<TDeadline>(options: {
  spawnSyncImpl: typeof spawnSync;
  cacheDir: string;
  deadline?: TDeadline;
  remainingMs: (deadline: TDeadline | undefined, cacheDir: string, command: string) => number | undefined;
  createError: (message: string, command: string, output: string) => Error;
}): Promise<string> {
  if (process.env.RUDDER_RUNTIME_INSTALL_OMIT_OPTIONAL !== "true") return "";
  const sharpPackage = await readRuntimePackageJson(options.cacheDir, "sharp");
  if (!sharpPackage) return "";
  const platformPackageName = resolveSharpPlatformPackageName(sharpPackage);
  if (!platformPackageName) return "";

  const installOptions = {
    deadline: options.deadline,
    cacheDir: options.cacheDir,
    remainingMs: options.remainingMs,
  };
  const requiredPackageVersions = new Map<string, string | null>([
    [platformPackageName, normalizeOptionalDependencyVersion(sharpPackage.optionalDependencies?.[platformPackageName])],
  ]);
  const requiredPackages = new Set([platformPackageName]);
  let output = "";
  for (let pass = 0; pass < 8; pass += 1) {
    const missingSpecs: string[] = [];
    for (const packageName of requiredPackages) {
      const version = requiredPackageVersions.get(packageName) ?? null;
      const packageJson = await readRuntimePackageJson(options.cacheDir, packageName);
      if (packageJson && (version === null || packageJson.version === version)) continue;
      missingSpecs.push(version ? `${packageName}@${version}` : packageName);
    }

    if (missingSpecs.length > 0) {
      await removeRuntimeInstallLocks(options.cacheDir);
      for (const packageSpec of missingSpecs) {
        const packageName = packageNameFromSpec(packageSpec);
        const result = await installRuntimePackageInStaging(
          options.spawnSyncImpl,
          options.cacheDir,
          packageSpec,
          packageName,
          installOptions,
        );
        output = collectOutputParts(output, collectSpawnOutput(result));
        if (result.status === 0 && await canResolveRuntimePackage(options.cacheDir, packageName)) continue;
        const command = formatRuntimePlatformRepairCommand(options.cacheDir, packageSpec);
        throw options.createError(
          `Rudder runtime installation is missing required native package ${packageName}. Re-run manually: ${command}`,
          command,
          output,
        );
      }
    }

    let discoveredNewPackage = false;
    for (const packageName of [...requiredPackages]) {
      const packageJson = await readRuntimePackageJson(options.cacheDir, packageName);
      for (const [dependencyName, versionRange] of Object.entries(packageJson?.optionalDependencies ?? {})) {
        if (requiredPackages.has(dependencyName)) continue;
        requiredPackages.add(dependencyName);
        requiredPackageVersions.set(dependencyName, normalizeOptionalDependencyVersion(versionRange));
        discoveredNewPackage = true;
      }
    }
    if (!discoveredNewPackage && await hasRequiredRuntimeNativeDependencies(options.cacheDir)) return output;
  }

  const command = [...requiredPackages]
    .map((packageName) => formatRuntimePlatformRepairCommand(
      options.cacheDir,
      requiredPackageVersions.get(packageName)
        ? `${packageName}@${requiredPackageVersions.get(packageName)}`
        : packageName,
    ))
    .join("; ");
  throw options.createError(
    "Rudder runtime native dependency preparation did not converge. Re-run manually: " + command,
    command,
    output,
  );
}

function formatRuntimePlatformRepairCommand(cacheDir: string, packageSpec: string): string {
  return `npm pack ${packageSpec} --registry=${NPM_PUBLIC_REGISTRY_URL} --silent, then extract it into ${path.join(cacheDir, "node_modules")}`;
}

function collectSpawnOutput(result: SpawnSyncResultLike): string {
  return [result.stdout, result.stderr, result.error instanceof Error ? result.error.message : null]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

function collectOutputParts(...parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join("\n").trim();
}

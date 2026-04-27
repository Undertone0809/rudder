import { execFileSync, spawnSync } from "node:child_process";

export const CLI_NPM_PACKAGE_NAME = "@rudderhq/cli";
export const CLI_BIN_NAME = "rudder";

interface PersistentCliStateOptions {
  entryPath?: string | null | undefined;
  env?: NodeJS.ProcessEnv;
  execFileSyncImpl?: typeof execFileSync;
}

interface InstallPersistentCliOptions {
  installSpec: string;
  spawnSyncImpl?: typeof spawnSync;
}

export interface PersistentCliState {
  usingNpx: boolean;
  alreadyInstalled: boolean;
  installSpec: string;
  installCommand: string;
}

export interface PersistentCliInstallResult {
  ok: boolean;
  command: string;
  output: string;
}

type SpawnSyncResultLike = ReturnType<typeof spawnSync>;

function normalizePath(value: string | null | undefined): string {
  return (value ?? "").replaceAll("\\", "/").toLowerCase();
}

export function isLikelyNpxExecutionContext(
  entryPath: string | null | undefined = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalizedEntry = normalizePath(entryPath);
  if (normalizedEntry.includes("/_npx/")) return true;

  const npmCommand = env.npm_command?.trim().toLowerCase();
  if (npmCommand === "exec" || npmCommand === "npx") return true;

  return false;
}

export function resolvePersistentCliInstallSpec(env: NodeJS.ProcessEnv = process.env): string {
  const pkgName = env.npm_package_name?.trim();
  const pkgVersion = env.npm_package_version?.trim();

  if (pkgName === CLI_NPM_PACKAGE_NAME && pkgVersion) {
    return `${pkgName}@${pkgVersion}`;
  }

  return CLI_NPM_PACKAGE_NAME;
}

function resolveCommandLookupExecutable(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "where", args: [CLI_BIN_NAME] };
  }
  return { command: "which", args: [CLI_BIN_NAME] };
}

export function isTransientBinaryPath(candidatePath: string | null | undefined): boolean {
  const normalized = normalizePath(candidatePath);
  return normalized.includes("/_npx/");
}

export function hasGlobalInstalledPackage(
  packageName: string,
  execFileSyncImpl: typeof execFileSync = execFileSync,
): boolean {
  return getGlobalInstalledPackageVersion(packageName, execFileSyncImpl) !== null;
}

export function getGlobalInstalledPackageVersion(
  packageName: string,
  execFileSyncImpl: typeof execFileSync = execFileSync,
): string | null {
  try {
    const output = execFileSyncImpl(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["list", "--global", "--depth=0", "--json", packageName],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const parsed = JSON.parse(output) as {
      dependencies?: Record<string, { version?: string }>;
    };
    return parsed.dependencies?.[packageName]?.version ?? null;
  } catch {
    return null;
  }
}

export function hasPersistentBinaryOnPath(
  execFileSyncImpl: typeof execFileSync = execFileSync,
): boolean {
  const { command, args } = resolveCommandLookupExecutable();

  try {
    const output = execFileSyncImpl(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const candidate = output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    return Boolean(candidate) && !isTransientBinaryPath(candidate);
  } catch {
    return false;
  }
}

export function detectPersistentCliState(options: PersistentCliStateOptions = {}): PersistentCliState {
  const env = options.env ?? process.env;
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const installSpec = resolvePersistentCliInstallSpec(env);
  const usingNpx = isLikelyNpxExecutionContext(options.entryPath ?? process.argv[1], env);

  if (!usingNpx) {
    return {
      usingNpx,
      alreadyInstalled: true,
      installSpec,
      installCommand: `npm install --global ${installSpec}`,
    };
  }

  const alreadyInstalled =
    hasGlobalInstalledPackage(CLI_NPM_PACKAGE_NAME, execFileSyncImpl) ||
    hasPersistentBinaryOnPath(execFileSyncImpl);

  return {
    usingNpx,
    alreadyInstalled,
    installSpec,
    installCommand: `npm install --global ${installSpec}`,
  };
}

export function installPersistentCli(
  options: InstallPersistentCliOptions,
): PersistentCliInstallResult {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const command = `npm install --global ${options.installSpec}`;
  const initialResult = runNpmGlobalInstall(spawnSyncImpl, ["install", "--global", options.installSpec]);
  const initialOutput = collectSpawnOutput(initialResult);

  if (initialResult.status === 0 || !isRudderBinConflict(initialOutput)) {
    return {
      ok: initialResult.status === 0,
      command,
      output: initialOutput,
    };
  }

  const forcedCommand = `npm install --global --force ${options.installSpec}`;
  const forcedResult = runNpmGlobalInstall(spawnSyncImpl, ["install", "--global", "--force", options.installSpec]);
  const forcedOutput = collectSpawnOutput(forcedResult);

  return {
    ok: forcedResult.status === 0,
    command: forcedCommand,
    output: forcedOutput || initialOutput,
  };
}

function runNpmGlobalInstall(
  spawnSyncImpl: typeof spawnSync,
  args: string[],
): SpawnSyncResultLike {
  return spawnSyncImpl(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
}

function collectSpawnOutput(result: SpawnSyncResultLike): string {
  return [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

function isRudderBinConflict(output: string): boolean {
  const normalized = output.toLowerCase().replaceAll("\\", "/");
  return (
    normalized.includes("eexist") &&
    (normalized.includes(`/${CLI_BIN_NAME}`) ||
      normalized.includes(`/${CLI_BIN_NAME}.cmd`) ||
      normalized.includes(`/${CLI_BIN_NAME}.ps1`))
  );
}

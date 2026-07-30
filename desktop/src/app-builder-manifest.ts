import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const APP_BUILDER_MANIFEST_FILENAME = "rudder.app.json";
export const APP_BUILDER_MANIFEST_SCHEMA_VERSION = 1;
export const OFFICIAL_APP_BUILDER_SCAFFOLD_ID = "rudder-next-sqlite";
export const APP_BUILDER_RUNTIME_ENGINE = "managed-node-22";
export const APP_BUILDER_PACKAGE_MANAGER = "managed-pnpm";
export const APP_BUILDER_DATA_EXPORT_FORMAT = "rudder-app-data/v1";

const MAX_MANIFEST_BYTES = 64 * 1024;
const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface AppBuilderManifest {
  schemaVersion: 1;
  app: {
    name: string;
    slug: string;
  };
  template: {
    id: typeof OFFICIAL_APP_BUILDER_SCAFFOLD_ID;
    revision: number;
  };
  runtime: {
    engine: typeof APP_BUILDER_RUNTIME_ENGINE;
    packageManager: typeof APP_BUILDER_PACKAGE_MANAGER;
    openPath: string;
    readinessPath: string;
    readinessTimeoutMs: number;
  };
  data: {
    provider: "sqlite";
    productionPath: string;
    developmentPath: string;
    migrationsDir: string;
    backupBeforeMigrate: true;
    exportFormat: typeof APP_BUILDER_DATA_EXPORT_FORMAT;
  };
  jobs: {
    mode: "in_process";
    lifecycle: "with_rudder";
    defaultCatchUpPolicy: "prompt";
  };
  secrets: Array<{ id: string; label: string; required: boolean }>;
}

export function assertAppBuilderAppId(value: unknown, label = "app id"): string {
  return requireBoundedString(value, label, {
    maxLength: 63,
    pattern: APP_ID_PATTERN,
  });
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function requireBoundedString(
  value: unknown,
  label: string,
  options: { maxLength: number; pattern?: RegExp },
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > options.maxLength) {
    throw new Error(`${label} must be between 1 and ${options.maxLength} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} contains control characters`);
  }
  if (options.pattern && !options.pattern.test(normalized)) {
    throw new Error(`${label} has an invalid format`);
  }
  return normalized;
}

function requireRoute(value: unknown, label: string): string {
  const route = requireBoundedString(value, label, { maxLength: 512 });
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\") || route.includes("?") || route.includes("#")) {
    throw new Error(`${label} must be a same-origin absolute path`);
  }
  return route;
}

export function normalizeAppBuilderRelativePath(
  value: unknown,
  label: string,
  options: { allowDot?: boolean } = {},
): string {
  const input = requireBoundedString(value, label, { maxLength: 512 });
  if (
    input.includes("\\")
    || input.includes(":")
    || path.posix.isAbsolute(input)
    || path.win32.isAbsolute(input)
  ) {
    throw new Error(`${label} must be a portable relative path`);
  }

  const normalized = path.posix.normalize(input);
  if (
    normalized === ".."
    || normalized.startsWith("../")
    || normalized.split("/").includes("..")
    || (!options.allowDot && normalized === ".")
  ) {
    throw new Error(`${label} must stay inside the app root`);
  }
  return normalized;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveExistingAncestor(candidate: string): Promise<{ ancestor: string; suffix: string[] }> {
  const suffix: string[] = [];
  let cursor = candidate;
  for (;;) {
    try {
      return { ancestor: await realpath(cursor), suffix };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function resolveAppBuilderPath(
  appRoot: string,
  relativePath: string,
  options: { mustExist?: boolean; allowDot?: boolean } = {},
): Promise<string> {
  const canonicalRoot = await realpath(appRoot);
  const normalized = normalizeAppBuilderRelativePath(relativePath, "app path", {
    allowDot: options.allowDot,
  });
  const candidate = path.resolve(canonicalRoot, ...normalized.split("/"));
  if (!isInside(canonicalRoot, candidate)) {
    throw new Error("app path escapes the app root");
  }

  if (options.mustExist) {
    const canonicalCandidate = await realpath(candidate);
    if (!isInside(canonicalRoot, canonicalCandidate)) {
      throw new Error("app path resolves outside the app root");
    }
    return canonicalCandidate;
  }

  const { ancestor, suffix } = await resolveExistingAncestor(candidate);
  if (!isInside(canonicalRoot, ancestor)) {
    throw new Error("app path resolves through a symlink outside the app root");
  }
  return path.join(ancestor, ...suffix);
}

export function parseAppBuilderManifest(input: unknown): AppBuilderManifest {
  assertPlainObject(input, "manifest");
  assertExactKeys(input, ["schemaVersion", "app", "template", "runtime", "data", "jobs", "secrets"], "manifest");
  if (input.schemaVersion !== APP_BUILDER_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`manifest.schemaVersion must be ${APP_BUILDER_MANIFEST_SCHEMA_VERSION}`);
  }

  assertPlainObject(input.app, "manifest.app");
  assertExactKeys(input.app, ["name", "slug"], "manifest.app");
  const name = requireBoundedString(input.app.name, "manifest.app.name", { maxLength: 120 });
  const slug = assertAppBuilderAppId(input.app.slug, "manifest.app.slug");

  assertPlainObject(input.template, "manifest.template");
  assertExactKeys(input.template, ["id", "revision"], "manifest.template");
  if (input.template.id !== OFFICIAL_APP_BUILDER_SCAFFOLD_ID) {
    throw new Error(`manifest.template.id must be ${OFFICIAL_APP_BUILDER_SCAFFOLD_ID}`);
  }
  if (!Number.isInteger(input.template.revision) || (input.template.revision as number) < 1) {
    throw new Error("manifest.template.revision must be a positive integer");
  }

  assertPlainObject(input.runtime, "manifest.runtime");
  assertExactKeys(
    input.runtime,
    ["engine", "packageManager", "openPath", "readinessPath", "readinessTimeoutMs"],
    "manifest.runtime",
  );
  if (
    input.runtime.engine !== APP_BUILDER_RUNTIME_ENGINE
    || input.runtime.packageManager !== APP_BUILDER_PACKAGE_MANAGER
  ) {
    throw new Error("manifest.runtime must use the managed App Builder runtime");
  }
  const openPath = requireRoute(input.runtime.openPath, "manifest.runtime.openPath");
  const readinessPath = requireRoute(input.runtime.readinessPath, "manifest.runtime.readinessPath");
  if (
    typeof input.runtime.readinessTimeoutMs !== "number"
    || !Number.isInteger(input.runtime.readinessTimeoutMs)
    || input.runtime.readinessTimeoutMs < 1_000
    || input.runtime.readinessTimeoutMs > 600_000
  ) {
    throw new Error("manifest.runtime.readinessTimeoutMs must be an integer between 1000 and 600000");
  }

  assertPlainObject(input.data, "manifest.data");
  assertExactKeys(
    input.data,
    [
      "provider",
      "productionPath",
      "developmentPath",
      "migrationsDir",
      "backupBeforeMigrate",
      "exportFormat",
    ],
    "manifest.data",
  );
  if (
    input.data.provider !== "sqlite"
    || input.data.backupBeforeMigrate !== true
    || input.data.exportFormat !== APP_BUILDER_DATA_EXPORT_FORMAT
  ) {
    throw new Error("manifest.data must use the maintained SQLite safety contract");
  }
  const productionPath = normalizeAppBuilderRelativePath(input.data.productionPath, "manifest.data.productionPath");
  const developmentPath = normalizeAppBuilderRelativePath(input.data.developmentPath, "manifest.data.developmentPath");
  const migrationsDir = normalizeAppBuilderRelativePath(input.data.migrationsDir, "manifest.data.migrationsDir");
  if (productionPath === developmentPath) throw new Error("development and production data paths must differ");

  assertPlainObject(input.jobs, "manifest.jobs");
  assertExactKeys(input.jobs, ["mode", "lifecycle", "defaultCatchUpPolicy"], "manifest.jobs");
  if (
    input.jobs.mode !== "in_process"
    || input.jobs.lifecycle !== "with_rudder"
    || input.jobs.defaultCatchUpPolicy !== "prompt"
  ) {
    throw new Error("manifest.jobs must use the Rudder-managed in-process lifecycle");
  }
  if (!Array.isArray(input.secrets) || input.secrets.length > 64) {
    throw new Error("manifest.secrets must be a bounded array");
  }
  const secretIds = new Set<string>();
  const secrets = input.secrets.map((secret, index) => {
    assertPlainObject(secret, `manifest.secrets[${index}]`);
    assertExactKeys(secret, ["id", "label", "required"], `manifest.secrets[${index}]`);
    const id = requireBoundedString(secret.id, `manifest.secrets[${index}].id`, {
      maxLength: 64,
      pattern: /^[a-z][a-z0-9_]*$/,
    });
    if (secretIds.has(id)) throw new Error("manifest secret ids must be unique");
    secretIds.add(id);
    if (typeof secret.required !== "boolean") throw new Error("manifest secret required must be boolean");
    return {
      id,
      label: requireBoundedString(secret.label, `manifest.secrets[${index}].label`, { maxLength: 120 }),
      required: secret.required,
    };
  });

  return {
    schemaVersion: APP_BUILDER_MANIFEST_SCHEMA_VERSION,
    app: { name, slug },
    template: {
      id: OFFICIAL_APP_BUILDER_SCAFFOLD_ID,
      revision: input.template.revision as number,
    },
    runtime: {
      engine: APP_BUILDER_RUNTIME_ENGINE,
      packageManager: APP_BUILDER_PACKAGE_MANAGER,
      openPath,
      readinessPath,
      readinessTimeoutMs: input.runtime.readinessTimeoutMs,
    },
    data: {
      provider: "sqlite",
      productionPath,
      developmentPath,
      migrationsDir,
      backupBeforeMigrate: true,
      exportFormat: APP_BUILDER_DATA_EXPORT_FORMAT,
    },
    jobs: {
      mode: "in_process",
      lifecycle: "with_rudder",
      defaultCatchUpPolicy: "prompt",
    },
    secrets,
  };
}

export async function readAppBuilderManifest(appRoot: string): Promise<AppBuilderManifest> {
  const canonicalRoot = await realpath(appRoot);
  const rootStat = await stat(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new Error("app root must be a directory");
  }

  const manifestPath = path.join(canonicalRoot, APP_BUILDER_MANIFEST_FILENAME);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`${APP_BUILDER_MANIFEST_FILENAME} must be a regular file`);
  }
  if (manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`${APP_BUILDER_MANIFEST_FILENAME} is too large`);
  }
  const manifestFile = await open(
    manifestPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedStat = await manifestFile.stat();
    if (!openedStat.isFile() || openedStat.size > MAX_MANIFEST_BYTES) {
      throw new Error(`${APP_BUILDER_MANIFEST_FILENAME} must be a bounded regular file`);
    }
    return parseAppBuilderManifest(
      JSON.parse(await manifestFile.readFile("utf8")) as unknown,
    );
  } finally {
    await manifestFile.close();
  }
}

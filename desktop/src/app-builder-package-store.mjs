import { createHash } from "node:crypto";
import path from "node:path";

const BASE_INSTALL_ARGS = ["install", "--frozen-lockfile", "--prefer-offline"];

export const APP_BUILDER_INHERITED_ENV_NAMES = [
  "ELECTRON_RUN_AS_NODE",
  "LOCALAPPDATA",
  "RUDDER_APP_BUILDER_CACHE_DIR",
  "RUDDER_APP_BUILDER_REGISTRY",
];

// Rudder packages pnpm 9.15.4, whose virtual-store directory segment is capped
// at 120 characters. The root budget below leaves room for that full segment
// plus the current scaffold's longest native esbuild executable suffix.
export const WINDOWS_APP_BUILDER_EXECUTABLE_PATH_LIMIT = 250;
export const WINDOWS_APP_BUILDER_DEPENDENCY_PATH_BUDGET = 170;
export const WINDOWS_APP_BUILDER_PNPM_VERSION = "9.15.4";
export const WINDOWS_APP_BUILDER_PNPM_SEGMENT_LIMIT = 120;
export const WINDOWS_APP_BUILDER_VIRTUAL_STORE_LIMIT =
  WINDOWS_APP_BUILDER_EXECUTABLE_PATH_LIMIT
  - WINDOWS_APP_BUILDER_DEPENDENCY_PATH_BUDGET;
const WINDOWS_APP_BUILDER_LAYOUT_VERSION = "v1";

function windowsDrivePath(value) {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const normalized = path.win32.normalize(value.trim());
  return /^[A-Za-z]:\\/.test(normalized) ? normalized : null;
}

function assertWindowsAbsolutePath(candidate, source) {
  if (
    typeof candidate !== "string"
    || candidate.includes("\0")
    || !path.win32.isAbsolute(candidate.trim())
  ) {
    throw new Error(`${source} must be an absolute Windows path`);
  }
  return path.win32.normalize(candidate.trim());
}

function assertWindowsCacheRoot(candidate, source) {
  const cacheRoot = windowsDrivePath(candidate);
  if (!cacheRoot) {
    throw new Error(
      `${source} must be an absolute Windows drive-letter path; UNC paths are unsupported`,
    );
  }
  return cacheRoot;
}

function virtualStoreKey(appRoot) {
  const canonicalIdentity = path.win32.normalize(appRoot).toLowerCase();
  return createHash("sha256").update(canonicalIdentity).digest("hex").slice(0, 16);
}

function windowsCacheRoot(options) {
  const configured = options.environment.RUDDER_APP_BUILDER_CACHE_DIR?.trim();
  if (configured) {
    return assertWindowsCacheRoot(configured, "RUDDER_APP_BUILDER_CACHE_DIR");
  }

  const candidates = [
    options.environment.LOCALAPPDATA,
    options.temporaryDirectory,
  ];
  for (const candidate of candidates) {
    const localRoot = windowsDrivePath(candidate);
    if (!localRoot) continue;
    const cacheRoot = path.win32.join(localRoot, "Rudder", "ab");
    const virtualStore = path.win32.join(
      cacheRoot,
      WINDOWS_APP_BUILDER_LAYOUT_VERSION,
      virtualStoreKey(options.appRoot),
    );
    if (virtualStore.length <= WINDOWS_APP_BUILDER_VIRTUAL_STORE_LIMIT) return cacheRoot;
  }

  throw new Error(
    "App Builder could not allocate a short Windows package cache; "
    + "set RUDDER_APP_BUILDER_CACHE_DIR to a short writable drive-letter path",
  );
}

export function appBuilderNodeShimName(platform = process.platform) {
  return platform === "win32" ? "node.cmd" : "node";
}

export function createAppBuilderInheritedEnvironment(environment) {
  const inheritedEnvironment = {};
  for (const name of APP_BUILDER_INHERITED_ENV_NAMES) {
    const value = environment[name];
    if (typeof value === "string") inheritedEnvironment[name] = value;
  }
  inheritedEnvironment.ELECTRON_RUN_AS_NODE = "1";
  return inheritedEnvironment;
}

export function createAppBuilderInstallPlan(options) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      args: [...BASE_INSTALL_ARGS],
      cacheRoot: null,
      contentStoreDir: null,
      layoutMarkerPath: null,
      virtualStoreDir: null,
    };
  }

  const appRoot = assertWindowsAbsolutePath(options.appRoot, "App Builder app root");
  const cacheRoot = windowsCacheRoot({ ...options, appRoot });
  const appKey = virtualStoreKey(appRoot);
  const virtualStoreDir = path.win32.join(
    cacheRoot,
    WINDOWS_APP_BUILDER_LAYOUT_VERSION,
    appKey,
  );
  const contentStoreDir = path.win32.join(cacheRoot, "s");
  const layoutMarkerPath = path.win32.join(
    cacheRoot,
    "state",
    WINDOWS_APP_BUILDER_LAYOUT_VERSION,
    `${appKey}.ready`,
  );
  if (virtualStoreDir.length > WINDOWS_APP_BUILDER_VIRTUAL_STORE_LIMIT) {
    throw new Error(
      `App Builder Windows virtual store exceeds its path budget (${virtualStoreDir.length} > `
      + `${WINDOWS_APP_BUILDER_VIRTUAL_STORE_LIMIT}); choose a shorter `
      + "RUDDER_APP_BUILDER_CACHE_DIR",
    );
  }

  return {
    args: [
      ...BASE_INSTALL_ARGS,
      "--virtual-store-dir",
      virtualStoreDir,
      "--store-dir",
      contentStoreDir,
    ],
    cacheRoot,
    contentStoreDir,
    layoutMarkerPath,
    virtualStoreDir,
  };
}

export function appBuilderInstallArgsForState(plan, state) {
  const needsLayoutMigration = Boolean(
    plan.virtualStoreDir
    && state.nodeModulesPresent
    && !state.layoutReady,
  );
  return needsLayoutMigration ? [...plan.args, "--force"] : [...plan.args];
}

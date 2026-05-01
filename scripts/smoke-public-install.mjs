#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
let packageSpec = "@rudderhq/cli@latest";
let repo = process.env.GITHUB_REPOSITORY || "Undertone0809/rudder";
let keepTemp = process.env.RUDDER_KEEP_PUBLIC_INSTALL_SMOKE_TEMP === "1";
let timeoutMs = Number.parseInt(process.env.RUDDER_PUBLIC_INSTALL_SMOKE_TIMEOUT_MS ?? "900000", 10);

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--package-spec") {
    packageSpec = args[++index] ?? "";
  } else if (arg === "--repo") {
    repo = args[++index] ?? "";
  } else if (arg === "--keep-temp") {
    keepTemp = true;
  } else if (arg === "--timeout-ms") {
    timeoutMs = Number.parseInt(args[++index] ?? "", 10);
  } else if (arg === "--help" || arg === "-h") {
    usage(0);
  } else {
    console.error(`Unexpected argument: ${arg}`);
    usage(1);
  }
}

if (!packageSpec || !repo) usage(1);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 900000;

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rudder-public-install-smoke."));
const homeDir = path.join(tempRoot, "home");
const npmCacheDir = path.join(tempRoot, "npm-cache");
const npmPrefixDir = path.join(tempRoot, "npm-prefix");
const outputDir = path.join(tempRoot, "output");
const installDir = path.join(tempRoot, "desktop-install");

await Promise.all([
  mkdir(homeDir, { recursive: true }),
  mkdir(npmCacheDir, { recursive: true }),
  mkdir(npmPrefixDir, { recursive: true }),
  mkdir(outputDir, { recursive: true }),
  mkdir(installDir, { recursive: true }),
]);

const appData = path.join(homeDir, "AppData", "Roaming");
const localAppData = path.join(homeDir, "AppData", "Local");
await Promise.all([
  mkdir(appData, { recursive: true }),
  mkdir(localAppData, { recursive: true }),
]);

const binDir = process.platform === "win32" ? npmPrefixDir : path.join(npmPrefixDir, "bin");
const env = {
  ...process.env,
  HOME: homeDir,
  USERPROFILE: homeDir,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  npm_config_cache: npmCacheDir,
  npm_config_prefix: npmPrefixDir,
  npm_config_yes: "true",
  PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
};

console.log(`[public-install-smoke] package: ${packageSpec}`);
console.log(`[public-install-smoke] repo: ${repo}`);
console.log(`[public-install-smoke] temp root: ${tempRoot}`);
console.log(`[public-install-smoke] platform: ${process.platform}/${process.arch}`);

try {
  run(
    "npx",
    [
      "--prefer-online",
      "--yes",
      packageSpec,
      "start",
      "--no-open",
      "--no-version-check",
      "--repo",
      repo,
      "--output-dir",
      outputDir,
      "--desktop-install-dir",
      installDir,
    ],
    env,
    timeoutMs,
  );

  const rudderCommand = process.platform === "win32" ? "rudder.cmd" : "rudder";
  run(rudderCommand, ["-V"], env, 60000);

  const metadataPath = path.join(installDir, ".rudder-desktop-install.json");
  if (!existsSync(metadataPath)) {
    throw new Error(`Desktop install metadata was not written: ${metadataPath}`);
  }

  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  console.log(
    `[public-install-smoke] installed ${metadata.releaseTag} from ${metadata.assetName}`,
  );
  console.log("[public-install-smoke] passed");
} finally {
  if (keepTemp) {
    console.log(`[public-install-smoke] keeping temp root: ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function run(command, commandArgs, commandEnv, commandTimeoutMs) {
  console.log(`[public-install-smoke] running: ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    env: commandEnv,
    stdio: "inherit",
    shell: process.platform === "win32",
    timeout: commandTimeoutMs,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${result.status}`);
  }
}

function usage(code) {
  console.error(
    "Usage: node scripts/smoke-public-install.mjs [--package-spec <npm-spec>] [--repo <owner/repo>] [--keep-temp] [--timeout-ms <ms>]",
  );
  process.exit(code);
}

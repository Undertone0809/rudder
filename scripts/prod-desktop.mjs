#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(repoRoot, "desktop", "release");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code: code ?? 0, signal });
    });
  });
}

function findNewestReleaseFile(extension) {
  const entries = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(releaseDir, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return entries[0] ?? null;
}

function findLaunchableArtifact() {
  if (process.platform === "darwin") {
    const appPath = path.join(releaseDir, `mac-${process.arch}`, "Rudder.app");
    if (existsSync(appPath)) return appPath;
    const fallback = path.join(releaseDir, "mac", "Rudder.app");
    if (existsSync(fallback)) return fallback;
  }
  if (process.platform === "win32") {
    const appPath = path.join(releaseDir, process.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked", "Rudder.exe");
    if (existsSync(appPath)) return appPath;
    const fallback = path.join(releaseDir, "win-unpacked", "Rudder.exe");
    if (existsSync(fallback)) return fallback;
  }
  return findNewestReleaseFile(".AppImage");
}

async function openArtifact(artifactPath) {
  if (process.platform === "darwin") {
    return await run("open", [artifactPath], { shell: false });
  }
  if (process.platform === "win32") {
    return await run("cmd", ["/c", "start", "", artifactPath], { shell: false });
  }
  return await run("xdg-open", [artifactPath], { shell: false });
}

async function main() {
  const distResult = await run(pnpmBin, ["desktop:dist"]);
  if (distResult.signal) {
    process.kill(process.pid, distResult.signal);
    return;
  }
  if (distResult.code !== 0) {
    process.exit(distResult.code);
  }

  const smokeResult = await run(process.execPath, ["desktop/scripts/smoke.mjs", "--mode=packaged"], {
    shell: false,
  });
  if (smokeResult.signal) {
    process.kill(process.pid, smokeResult.signal);
    return;
  }
  if (smokeResult.code !== 0) {
    console.error("[rudder:prod] packaged desktop smoke failed; refusing to open the app");
    process.exit(smokeResult.code);
  }

  const artifactPath = findLaunchableArtifact();
  if (!artifactPath) {
    console.error(`[rudder:prod] built desktop artifacts, but could not find a launchable artifact in ${releaseDir}`);
    process.exit(1);
  }

  console.log(`[rudder:prod] opening packaged desktop app: ${artifactPath}`);
  const openResult = await openArtifact(artifactPath);
  if (openResult.signal) {
    process.kill(process.pid, openResult.signal);
    return;
  }
  if (openResult.code !== 0) {
    console.error(`[rudder:prod] failed to open the packaged app automatically. Open this file manually:\n${artifactPath}`);
    process.exit(openResult.code);
  }
}

void main().catch((error) => {
  console.error("[rudder:prod] failed to build or open the production desktop app", error);
  process.exit(1);
});

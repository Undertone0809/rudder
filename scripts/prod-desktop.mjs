#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
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

function currentPlatformArtifactExtension() {
  if (process.platform === "darwin") return ".dmg";
  if (process.platform === "win32") return ".exe";
  return ".AppImage";
}

function findNewestInstallerArtifact() {
  const extension = currentPlatformArtifactExtension();
  const entries = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(releaseDir, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return entries[0] ?? null;
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
    console.error("[rudder:prod] packaged desktop smoke failed; refusing to open the installer");
    process.exit(smokeResult.code);
  }

  const artifactPath = findNewestInstallerArtifact();
  if (!artifactPath) {
    console.error(`[rudder:prod] built desktop artifacts, but could not find an installer in ${releaseDir}`);
    process.exit(1);
  }

  console.log(`[rudder:prod] opening installer: ${artifactPath}`);
  const openResult = await openArtifact(artifactPath);
  if (openResult.signal) {
    process.kill(process.pid, openResult.signal);
    return;
  }
  if (openResult.code !== 0) {
    console.error(`[rudder:prod] failed to open installer automatically. Open this file manually:\n${artifactPath}`);
    process.exit(openResult.code);
  }
}

void main().catch((error) => {
  console.error("[rudder:prod] failed to build or open the production desktop installer", error);
  process.exit(1);
});

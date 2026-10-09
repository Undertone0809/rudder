import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const tscBin = process.platform === "win32" ? "tsc.cmd" : "tsc";

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--workspace-built")) {
    throw new Error(`Unknown desktop build argument: ${args.join(" ")}`);
  }
  const workspaceBuilt = args.includes("--workspace-built");
  // The root build waits for all workspace outputs before staging Desktop.
  // Re-entering the workspace build from a recursive package job races its
  // clean/write steps (notably db/dist). Standalone Desktop builds still own
  // their dependency and UI builds.
  if (!workspaceBuilt) {
    await run(pnpmBin, ["--filter", "@rudderhq/server...", "build"], repoRoot);
  }
  await run(pnpmBin, [
    "--filter", "@rudderhq/server", "prepare:ui-dist",
    ...(workspaceBuilt ? ["--skip-build"] : []),
  ], repoRoot);
  await run(process.execPath, ["scripts/stage-server.mjs"], desktopRoot);
  await run(process.execPath, ["scripts/stage-cli.mjs"], desktopRoot);
  await run(process.execPath, ["scripts/stage-native.mjs"], desktopRoot);
  await fs.rm(path.join(desktopRoot, "dist"), { recursive: true, force: true });
  await run(tscBin, ["-p", "tsconfig.json"], desktopRoot);
  await run(process.execPath, ["scripts/stage-app-builder-toolchain.mjs"], desktopRoot);
  await run(process.execPath, ["scripts/stage-app.mjs"], desktopRoot);
}

void main().catch((error) => {
  console.error("[desktop:build] failed", error);
  process.exit(1);
});

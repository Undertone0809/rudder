#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(desktopDir, "package.json");
const releaseDir = path.join(desktopDir, "release");

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key.slice(2)] = true;
      continue;
    }
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: desktopDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}${error.stack ?? error.message}` });
    });
    child.on("exit", (code, signal) => {
      resolve({
        code: signal ? 1 : code ?? 1,
        stdout,
        stderr: signal ? `${stderr}${command} exited with signal ${signal}` : stderr,
      });
    });
  });
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function printCommandFailure(command, args, result) {
  console.error(`[desktop:verify-signing] ${command} ${args.join(" ")} failed`);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output) console.error(output);
}

async function requireCommand(command, args) {
  const result = await run(command, args);
  if (result.code !== 0) {
    printCommandFailure(command, args, result);
    throw new Error(`${command} exited with code ${result.code}`);
  }
  return result;
}

async function verifyApp(appPath) {
  if (!(await exists(appPath))) {
    throw new Error(`Rudder.app not found at ${appPath}`);
  }

  await requireCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);

  const details = await requireCommand("codesign", ["-dv", "--verbose=4", appPath]);
  const detailsText = `${details.stdout}${details.stderr}`;
  if (/Signature=adhoc/.test(detailsText)) {
    throw new Error(`${appPath} is ad-hoc signed, not Developer ID signed`);
  }
  if (!/^TeamIdentifier=(?!not set$).+/m.test(detailsText)) {
    throw new Error(`${appPath} does not have a Developer ID TeamIdentifier`);
  }

  await requireCommand("xcrun", ["stapler", "validate", appPath]);
  await requireCommand("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
}

async function withMountedDmg(dmgPath, callback) {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-dmg-verify."));
  try {
    await requireCommand("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    await callback(mountPoint);
  } finally {
    await run("hdiutil", ["detach", mountPoint]);
    await fs.rm(mountPoint, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("verify-macos-release-signing.mjs only supports macOS");
  }

  const args = readArgs(process.argv.slice(2));
  const arch = args.arch || process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const productName = packageJson.build?.productName ?? packageJson.productName ?? packageJson.name;
  const version = packageJson.version;

  if (args.app) {
    await verifyApp(path.resolve(args.app));
  } else if (!args["dmg-only"]) {
    const appPathCandidates = [
      path.join(releaseDir, `mac-${arch}`, `${productName}.app`),
      path.join(releaseDir, "mac", `${productName}.app`),
    ];
    let appPath = null;
    for (const candidate of appPathCandidates) {
      if (await exists(candidate)) {
        appPath = candidate;
        break;
      }
    }
    if (!appPath && !args.dmg) {
      throw new Error(`Rudder.app not found in: ${appPathCandidates.join(", ")}`);
    }
    if (appPath) await verifyApp(appPath);
  }

  const dmgPath = args.dmg ? path.resolve(args.dmg) : path.join(releaseDir, `${productName}-${version}-${arch}.dmg`);
  if (await exists(dmgPath)) {
    await withMountedDmg(dmgPath, async (mountPoint) => {
      await verifyApp(path.join(mountPoint, `${productName}.app`));
    });
  } else if (args["dmg-only"]) {
    throw new Error(`DMG not found at ${dmgPath}`);
  }

  console.log(`[desktop:verify-signing] verified Developer ID signature, notarization, and Gatekeeper assessment for ${arch}`);
}

void main().catch((error) => {
  console.error("[desktop:verify-signing] failed", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

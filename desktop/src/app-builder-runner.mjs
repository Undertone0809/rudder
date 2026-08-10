import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_FILENAME = "rudder.app.json";
const LOOPBACK_HOST = "127.0.0.1";

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolvePnpmCli() {
  const staged = fileURLToPath(
    new URL("./toolchain/pnpm/bin/pnpm.cjs", import.meta.url),
  );
  if (await exists(staged)) return staged;

  const workspacePackage = fileURLToPath(
    new URL("../node_modules/pnpm/package.json", import.meta.url),
  );
  if (await exists(workspacePackage)) {
    return path.join(path.dirname(workspacePackage), "bin", "pnpm.cjs");
  }

  throw new Error("The Rudder-managed pnpm runtime is unavailable");
}

async function resolveManagedNodeBin() {
  const staged = fileURLToPath(
    new URL("./toolchain/node/bin", import.meta.url),
  );
  const stagedShim = path.join(
    staged,
    process.platform === "win32" ? "node.cmd" : "node",
  );
  if (await exists(stagedShim)) return staged;

  if (/^node(?:\.exe)?$/i.test(path.basename(process.execPath))) {
    return path.dirname(process.execPath);
  }

  throw new Error("The Rudder-managed Node runtime shim is unavailable");
}

async function readManifest(appRoot) {
  const raw = await readFile(path.join(appRoot, MANIFEST_FILENAME), "utf8");
  const manifest = JSON.parse(raw);
  if (
    manifest?.schemaVersion !== 1
    || manifest?.runtime?.engine !== "managed-node-22"
    || manifest?.runtime?.packageManager !== "managed-pnpm"
  ) {
    throw new Error("The App Builder manifest does not use the supported managed runtime");
  }
  return manifest;
}

function runPnpm(pnpmCli, args, appRoot, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpmCli, ...args], {
      cwd: appRoot,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`pnpm ${args.join(" ")} exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`pnpm ${args.join(" ")} exited with status ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

function installArgs(appRoot) {
  const args = ["install", "--frozen-lockfile", "--prefer-offline"];
  if (process.platform !== "win32") return args;

  const appKey = createHash("sha256").update(appRoot).digest("hex").slice(0, 16);
  const localDataRoot = process.env.LOCALAPPDATA || os.tmpdir();
  return [
    ...args,
    "--virtual-store-dir",
    path.join(localDataRoot, "Rudder", "app-builder-pnpm", appKey),
  ];
}

async function main() {
  const [appRootInput, command = "preview", dataRootInput] = process.argv.slice(2);
  if (!appRootInput || !path.isAbsolute(appRootInput)) {
    throw new Error("App Builder runner requires an absolute app root");
  }
  if (command !== "preview" && command !== "migrate") {
    throw new Error(`Unsupported App Builder runner command: ${command}`);
  }

  const port = Number(process.env.PORT);
  if (
    command === "preview"
    && (!Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    throw new Error("App Builder runner requires a valid managed preview port");
  }

  const appRoot = path.resolve(appRootInput);
  await readManifest(appRoot);
  const pnpmCli = await resolvePnpmCli();
  const managedNodeBin = await resolveManagedNodeBin();
  const environment = {
    ...process.env,
    CI: "1",
    ELECTRON_RUN_AS_NODE: "1",
    HOST: LOOPBACK_HOST,
    PATH: [managedNodeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    ...(command === "preview" ? { PORT: String(port) } : {}),
    NEXT_TELEMETRY_DISABLED: "1",
    RUDDER_APP_BUILDER_NODE_EXECUTABLE: process.execPath,
    RUDDER_APP_DATA_MODE: "development",
  };

  await runPnpm(
    pnpmCli,
    installArgs(appRoot),
    appRoot,
    environment,
  );
  if (command === "migrate") {
    if (!dataRootInput || !path.isAbsolute(dataRootInput)) {
      throw new Error("App Builder migration requires an absolute staged data root");
    }
    await runPnpm(pnpmCli, ["run", "typecheck"], appRoot, environment);
    await runPnpm(pnpmCli, ["run", "test"], appRoot, environment);
    await runPnpm(pnpmCli, ["run", "build"], appRoot, environment);
    await runPnpm(pnpmCli, ["run", "db:migrate"], appRoot, {
      ...environment,
      RUDDER_APP_DATA_DIR: path.resolve(dataRootInput),
      RUDDER_APP_DATA_MODE: "production",
    });
    return;
  }
  await runPnpm(pnpmCli, ["run", "verify"], appRoot, environment);
  await runPnpm(pnpmCli, ["run", "dev"], appRoot, environment);
}

void main().catch((error) => {
  console.error(
    "[app-builder-runner] failed",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});

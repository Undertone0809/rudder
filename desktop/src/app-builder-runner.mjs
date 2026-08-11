import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, link, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  appBuilderInstallArgsForState,
  appBuilderNodeShimName,
  createAppBuilderInstallPlan,
} from "./app-builder-package-store.mjs";

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
  if (/^node(?:\.exe)?$/i.test(path.basename(process.execPath))) {
    return path.dirname(process.execPath);
  }

  if (process.platform === "win32") {
    const executableDir = path.dirname(process.execPath);
    const managedNode = path.join(executableDir, "node.exe");
    try {
      await link(process.execPath, managedNode);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        try {
          await copyFile(process.execPath, managedNode, constants.COPYFILE_EXCL);
        } catch (copyError) {
          if (copyError?.code !== "EEXIST") throw copyError;
        }
      }
    }
    const [sourceStats, managedStats] = await Promise.all([
      stat(process.execPath),
      stat(managedNode),
    ]);
    if (sourceStats.size !== managedStats.size) {
      throw new Error("The managed Windows Node executable does not match Rudder");
    }
    return executableDir;
  }

  const staged = fileURLToPath(
    new URL("./toolchain/node/bin", import.meta.url),
  );
  const stagedShim = path.join(staged, appBuilderNodeShimName());
  if (await exists(stagedShim)) return staged;

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

async function verifyApp(pnpmCli, appRoot, environment) {
  if (process.platform !== "win32") {
    await runPnpm(pnpmCli, ["run", "verify"], appRoot, environment);
    return;
  }

  await runPnpm(pnpmCli, ["run", "ui:check"], appRoot, environment);
  await runPnpm(pnpmCli, ["run", "typecheck"], appRoot, environment);
  await runPnpm(pnpmCli, ["run", "test"], appRoot, environment);
  await runPnpm(pnpmCli, ["exec", "next", "build", "--webpack"], appRoot, environment);
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
  const nextCompatPreload = fileURLToPath(
    new URL("./app-builder-next-compat.mjs", import.meta.url),
  );
  await access(nextCompatPreload);
  const installPlan = createAppBuilderInstallPlan({
    appRoot,
    environment: process.env,
    platform: process.platform,
    temporaryDirectory: os.tmpdir(),
  });
  const environment = {
    ...process.env,
    CI: "1",
    ELECTRON_RUN_AS_NODE: "1",
    HOST: LOOPBACK_HOST,
    PATH: [managedNodeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    ...(command === "preview" ? { PORT: String(port) } : {}),
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(nextCompatPreload).href}`,
    ].filter(Boolean).join(" "),
    npm_config_registry: process.env.RUDDER_APP_BUILDER_REGISTRY || "https://registry.npmjs.org/",
    RUDDER_APP_BUILDER_NEXT_COMPAT: "1",
    RUDDER_APP_BUILDER_NODE_EXECUTABLE: process.execPath,
    RUDDER_APP_DATA_MODE: "development",
  };
  const installArgs = appBuilderInstallArgsForState(installPlan, {
    nodeModulesPresent: await exists(path.join(appRoot, "node_modules")),
    layoutReady: installPlan.layoutMarkerPath
      ? await exists(installPlan.layoutMarkerPath)
      : false,
  });

  await runPnpm(
    pnpmCli,
    installArgs,
    appRoot,
    environment,
  );
  if (installPlan.layoutMarkerPath) {
    await mkdir(path.dirname(installPlan.layoutMarkerPath), { recursive: true });
    await writeFile(installPlan.layoutMarkerPath, "ready\n", "utf8");
  }
  if (command === "migrate") {
    if (!dataRootInput || !path.isAbsolute(dataRootInput)) {
      throw new Error("App Builder migration requires an absolute staged data root");
    }
    await verifyApp(pnpmCli, appRoot, environment);
    await runPnpm(pnpmCli, ["run", "db:migrate"], appRoot, {
      ...environment,
      RUDDER_APP_DATA_DIR: path.resolve(dataRootInput),
      RUDDER_APP_DATA_MODE: "production",
    });
    return;
  }
  await verifyApp(pnpmCli, appRoot, environment);
  await runPnpm(
    pnpmCli,
    process.platform === "win32" ? ["run", "dev", "--webpack"] : ["run", "dev"],
    appRoot,
    environment,
  );
}

void main().catch((error) => {
  console.error(
    "[app-builder-runner] failed",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});

import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const sourceRunner = fileURLToPath(
  new URL("./app-builder-runner.mjs", import.meta.url),
);
const desktopPackageJson = fileURLToPath(
  new URL("../package.json", import.meta.url),
);
const sourcePackageStore = fileURLToPath(
  new URL("./app-builder-package-store.mjs", import.meta.url),
);
const sourceNextCompat = fileURLToPath(
  new URL("./app-builder-next-compat.mjs", import.meta.url),
);
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-app-runner-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const appRoot = path.join(root, "app");
  const dataRoot = path.join(root, "staged-data");
  const logPath = path.join(root, "pnpm-calls.jsonl");
  const cacheRoot = process.platform === "win32"
    ? path.join(path.parse(root).root, `rab-${path.basename(root).slice(-6)}`)
    : path.join(root, "cache");
  if (process.platform === "win32") roots.push(cacheRoot);
  const runner = path.join(runtimeRoot, "app-builder-runner.mjs");
  const packageStore = path.join(runtimeRoot, "app-builder-package-store.mjs");
  const nextCompat = path.join(runtimeRoot, "app-builder-next-compat.mjs");
  const pnpmCli = path.join(runtimeRoot, "toolchain", "pnpm", "bin", "pnpm.cjs");
  const nodeBin = path.join(runtimeRoot, "toolchain", "node", "bin");
  const nodeShim = path.join(nodeBin, process.platform === "win32" ? "node.cmd" : "node");
  await mkdir(runtimeRoot, { recursive: true });
  await Promise.all([
    copyFile(sourcePackageStore, packageStore),
    copyFile(sourceNextCompat, nextCompat),
    mkdir(path.dirname(pnpmCli), { recursive: true }),
    mkdir(nodeBin, { recursive: true }),
    mkdir(appRoot, { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
  ]);
  await copyFile(sourceRunner, runner);
  await writeFile(pnpmCli, [
    'const fs = require("node:fs");',
    'require("node:child_process").execFileSync("node", ["-e", "process.stdout.write(process.execPath)"]);',
    "fs.appendFileSync(process.env.APP_BUILDER_RUNNER_TEST_LOG,",
    '  JSON.stringify({ argv: process.argv.slice(2), dataRoot: process.env.RUDDER_APP_DATA_DIR ?? null, nodeExecutable: process.env.RUDDER_APP_BUILDER_NODE_EXECUTABLE, nodeOptions: process.env.NODE_OPTIONS, registry: process.env.npm_config_registry }) + "\\n");',
  ].join("\n"));
  if (process.platform === "win32") {
    await writeFile(nodeShim, [
      "@echo off",
      "set ELECTRON_RUN_AS_NODE=1",
      '"%RUDDER_APP_BUILDER_NODE_EXECUTABLE%" %*',
      "",
    ].join("\r\n"));
  } else {
    await writeFile(nodeShim, [
      "#!/bin/sh",
      "export ELECTRON_RUN_AS_NODE=1",
      'exec "$RUDDER_APP_BUILDER_NODE_EXECUTABLE" "$@"',
      "",
    ].join("\n"));
    await chmod(nodeShim, 0o755);
  }
  await writeFile(
    path.join(appRoot, "rudder.app.json"),
    JSON.stringify({
      schemaVersion: 1,
      runtime: {
        engine: "managed-node-22",
        packageManager: "managed-pnpm",
      },
    }),
  );
  return { appRoot, cacheRoot, dataRoot, logPath, runner };
}

async function run(
  runner: string,
  args: string[],
  logPath: string,
  extraEnv: NodeJS.ProcessEnv = {},
  executable = process.execPath,
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [runner, ...args], {
      env: {
        ...process.env,
        APP_BUILDER_RUNNER_TEST_LOG: logPath,
        ELECTRON_RUN_AS_NODE: "1",
        ...extraEnv,
      },
      shell: false,
      stdio: "pipe",
    });
    let diagnostics = "";
    child.stdout.on("data", (chunk) => { diagnostics += String(chunk); });
    child.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(diagnostics || `runner exited with ${signal ?? code}`));
    });
  });
}

async function calls(logPath: string) {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      argv: string[];
      dataRoot: string | null;
      nodeExecutable: string;
      nodeOptions: string;
      registry: string;
    });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe("App Builder managed runner", () => {
  it("stages the managed toolchain before launching the Desktop dev shell", async () => {
    const packageJson = JSON.parse(await readFile(desktopPackageJson, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const devScript = packageJson.scripts?.dev ?? "";
    expect(devScript).toContain("pnpm run stage:app-builder-toolchain");
    expect(devScript.indexOf("pnpm run stage:app-builder-toolchain"))
      .toBeLessThan(devScript.indexOf("electron dist/main.js"));
  });

  it("installs from the lockfile, verifies, and starts a loopback preview", async () => {
    const { appRoot, logPath, runner } = await fixture();
    await run(runner, [appRoot, "preview"], logPath, { PORT: "43123" });
    const install = ["install", "--frozen-lockfile", "--prefer-offline"];
    if (process.platform === "win32") install.push(
      "--virtual-store-dir",
      expect.stringContaining(`${path.win32.sep}Rudder${path.win32.sep}ab${path.win32.sep}v1${path.win32.sep}`) as string,
      "--store-dir",
      expect.stringContaining(`${path.win32.sep}Rudder${path.win32.sep}ab${path.win32.sep}s`) as string,
    );
    const verification = process.platform === "win32"
      ? [
          ["run", "ui:check"],
          ["run", "typecheck"],
          ["run", "test"],
          ["exec", "next", "build", "--webpack"],
        ]
      : [["run", "verify"]];
    expect((await calls(logPath)).map((call) => call.argv)).toEqual([
      install,
      ...verification,
      process.platform === "win32" ? ["run", "dev", "--webpack"] : ["run", "dev"],
    ]);
    expect((await calls(logPath)).every(
      (call) => call.registry === "https://registry.npmjs.org/",
    )).toBe(true);
    expect((await calls(logPath)).every(
      (call) => call.nodeOptions.includes("app-builder-next-compat.mjs"),
    )).toBe(true);
  }, 15_000);

  it("rehearses checks and migrations against only the staged data root", async () => {
    const { appRoot, dataRoot, logPath, runner } = await fixture();
    await run(runner, [appRoot, "migrate", dataRoot], logPath);
    const recorded = await calls(logPath);
    const install = ["install", "--frozen-lockfile", "--prefer-offline"];
    if (process.platform === "win32") install.push(
      "--virtual-store-dir",
      expect.stringContaining(`${path.win32.sep}Rudder${path.win32.sep}ab${path.win32.sep}v1${path.win32.sep}`) as string,
      "--store-dir",
      expect.stringContaining(`${path.win32.sep}Rudder${path.win32.sep}ab${path.win32.sep}s`) as string,
    );
    const verification = process.platform === "win32"
      ? [
          ["run", "ui:check"],
          ["run", "typecheck"],
          ["run", "test"],
          ["exec", "next", "build", "--webpack"],
        ]
      : [["run", "verify"]];
    expect(recorded.map((call) => call.argv)).toEqual([
      install,
      ...verification,
      ["run", "db:migrate"],
    ]);
    expect(recorded.at(-1)?.dataRoot).toBe(dataRoot);
    expect(recorded.slice(0, -1).every((call) => call.dataRoot === null)).toBe(true);
  }, 15_000);

  it.skipIf(process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === "1")(
    "provides a managed node command when Electron hosts the runner",
    async () => {
      const { default: electronBinary } = await import("electron");
      const { appRoot, cacheRoot, logPath, runner } = await fixture();
      await run(
        runner,
        [appRoot, "preview"],
        logPath,
        { PORT: "43124", RUDDER_APP_BUILDER_CACHE_DIR: cacheRoot },
        electronBinary,
      );
      expect((await calls(logPath)).every(
        (call) => call.nodeExecutable === electronBinary,
      )).toBe(true);
    },
    30_000,
  );
});

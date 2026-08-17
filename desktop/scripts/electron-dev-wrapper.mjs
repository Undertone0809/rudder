#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronCli = require.resolve("electron/cli.js");
const tsxLoader = require.resolve("tsx");
const nodeOptions = [process.env.NODE_OPTIONS, `--import=${tsxLoader}`].filter(Boolean).join(" ");
const child = spawn(process.execPath, [electronCli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error("[desktop:dev-wrapper] failed to launch Electron", error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

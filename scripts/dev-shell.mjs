#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevScriptEnvironment, resolveHomeDir } from "./dev-local-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cliArgs = process.argv.slice(2);
const runtimeMode = cliArgs[0] === "watch" ? "watch" : "dev";
const forwardedArgs = cliArgs[0] === "watch" || cliArgs[0] === "dev" ? cliArgs.slice(1) : cliArgs;
const runtimeLabel = runtimeMode === "watch" ? "watched dev runtime" : "dev runtime";
const startupTimeoutMs = 120_000;
const pollIntervalMs = 250;

let shuttingDown = false;
let desktopStarted = false;
let serverChild = null;
let desktopChild = null;

function resolveDescriptorPath(env) {
  const instanceId = env.RUDDER_INSTANCE_ID?.trim() || "dev";
  const homeDir = resolveHomeDir(env.RUDDER_HOME);
  return path.join(homeDir, "instances", instanceId, "runtime", "server.json");
}

function readDescriptor(descriptorPath) {
  if (!existsSync(descriptorPath)) return null;
  try {
    return JSON.parse(readFileSync(descriptorPath, "utf8"));
  } catch {
    return null;
  }
}

async function waitForDevRuntimeReady(env) {
  const descriptorPath = resolveDescriptorPath(env);
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (!serverChild) {
      throw new Error(`The ${runtimeLabel} exited before becoming ready.`);
    }

    const descriptor = readDescriptor(descriptorPath);
    if (descriptor?.apiUrl && descriptor?.ownerKind === "dev_runner") {
      try {
        const response = await fetch(`${String(descriptor.apiUrl).replace(/\/+$/, "")}/api/health`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(1_500),
        });
        if (response.ok) {
          const payload = await response.json();
          if (
            payload?.status === "ok"
            && payload?.runtimeOwnerKind === "dev_runner"
            && payload?.instanceId === (env.RUDDER_INSTANCE_ID?.trim() || "dev")
          ) {
            return;
          }
          lastError = new Error(`Health check returned a runtime, but not the ${runtimeLabel} yet.`);
        } else {
          lastError = new Error(`Health check failed (${response.status}).`);
        }
      } catch (error) {
        lastError = error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for the ${runtimeLabel} to become healthy. ${
      lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown error")
    }`,
  );
}

function spawnManagedChild(name, command, args, env, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    shell: options.shell ?? process.platform === "win32",
    ...options,
  });
  child.on("error", (error) => {
    console.error(`[rudder:${name}] failed to start`, error);
    void shutdown(name === "server" ? 1 : 0);
  });
  return child;
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  const waits = [];
  if (desktopChild && !desktopChild.killed) {
    desktopChild.kill("SIGTERM");
    waits.push(new Promise((resolve) => desktopChild.once("exit", resolve)));
  }
  if (serverChild && !serverChild.killed) {
    serverChild.kill("SIGTERM");
    waits.push(new Promise((resolve) => serverChild.once("exit", resolve)));
  }

  if (waits.length > 0) {
    await Promise.race([
      Promise.allSettled(waits),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }

  process.exit(exitCode);
}

async function main() {
  const { env } = resolveDevScriptEnvironment({
    repoRoot,
    baseEnv: process.env,
  });
  const desktopEnv = {
    ...env,
  };

  serverChild = spawnManagedChild(
    "server",
    process.execPath,
    [
      path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "scripts", "dev-runner.mjs"),
      runtimeMode,
      ...forwardedArgs,
    ],
    env,
    { shell: false },
  );
  serverChild.once("exit", (code, signal) => {
    serverChild = null;
    if (shuttingDown) return;
    if (desktopChild && !desktopChild.killed) {
      desktopChild.kill("SIGTERM");
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  await waitForDevRuntimeReady(env);

  desktopChild = spawnManagedChild(
    "desktop",
    pnpmBin,
    ["--filter", "@rudder/desktop", "dev"],
    desktopEnv,
  );
  desktopStarted = true;
  desktopChild.once("exit", (code, signal) => {
    desktopChild = null;
    if (shuttingDown) return;
    if (signal) {
      console.warn(`[rudder:desktop] desktop shell exited via ${signal}. ${runtimeLabel} is still running.`);
      return;
    }
    if ((code ?? 0) !== 0) {
      console.warn(`[rudder:desktop] desktop shell exited with code ${code}. ${runtimeLabel} is still running.`);
      return;
    }
    console.log(`[rudder:desktop] desktop shell closed. ${runtimeLabel} is still running.`);
  });
}

process.on("SIGINT", () => {
  void shutdown(130);
});

process.on("SIGTERM", () => {
  void shutdown(143);
});

void main().catch((error) => {
  console.error("[rudder:dev] failed to launch desktop dev shell", error);
  if (!desktopStarted) {
    void shutdown(1);
    return;
  }
  process.exit(1);
});

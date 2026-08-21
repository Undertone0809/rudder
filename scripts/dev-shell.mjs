#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevIdentityEnvironment } from "./dev-identity-env.mjs";
import {
  DEV_RUNTIME_STARTUP_TIMEOUT_MS,
  isolateDevShellFromParentRuntime,
  resolveDevDesktopEnvironment,
  resolveDevScriptEnvironment,
  resolveHomeDir,
} from "./dev-local-env.mjs";
import {
  classifyDevDesktopExit,
  classifyDevServerExit,
} from "./dev-shell-lifecycle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cliArgs = process.argv.slice(2);
const runtimeMode = cliArgs[0] === "watch" ? "watch" : "dev";
const forwardedArgs = cliArgs[0] === "watch" || cliArgs[0] === "dev" ? cliArgs.slice(1) : cliArgs;
const runtimeLabel = runtimeMode === "watch" ? "watched dev runtime" : "dev runtime";
const startupTimeoutMs = DEV_RUNTIME_STARTUP_TIMEOUT_MS;
const pollIntervalMs = 250;
const desktopTakeoverVerificationTimeoutMs = 10_000;

let shuttingDown = false;
let desktopStarted = false;
let desktopOwnsRuntime = false;
let serverChild = null;
let identityChild = null;
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

async function waitForDesktopRuntimeOwnership(env) {
  const descriptorPath = resolveDescriptorPath(env);
  const deadline = Date.now() + desktopTakeoverVerificationTimeoutMs;

  while (Date.now() < deadline) {
    const descriptor = readDescriptor(descriptorPath);
    if (descriptor?.apiUrl && descriptor?.ownerKind === "desktop") {
      try {
        const response = await fetch(`${String(descriptor.apiUrl).replace(/\/+$/, "")}/api/health`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(1_500),
        });
        if (response.ok) {
          const payload = await response.json();
          if (
            payload?.status === "ok"
            && payload?.runtimeOwnerKind === "desktop"
            && payload?.instanceId === (env.RUDDER_INSTANCE_ID?.trim() || "dev")
          ) {
            return "desktop";
          }
        }
      } catch {
        // Desktop takeover can briefly leave the descriptor ahead of health readiness.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return null;
}

async function waitForIdentityReady(identityOrigin) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (!identityChild) {
      throw new Error("The local Identity service exited before becoming ready.");
    }
    try {
      const response = await fetch(new URL("/api/health", identityOrigin), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) {
        const payload = await response.json();
        if (payload?.status === "ok" && payload?.service === "rudder-identity") return;
        lastError = new Error("Identity health returned an unexpected service.");
      } else {
        lastError = new Error(`Identity health failed (${response.status}).`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for local Identity. ${
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

async function runManagedCommand(name, command, args, env) {
  const child = spawnManagedChild(name, command, args, env);
  const result = await new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${name} exited via ${signal}`));
        return;
      }
      if ((code ?? 1) !== 0) {
        reject(new Error(`${name} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
  return result;
}

async function shutdown(exitCode = 0, finalSignal = null) {
  if (shuttingDown) return;
  shuttingDown = true;

  const waits = [];
  if (desktopChild && !desktopChild.killed) {
    desktopChild.kill("SIGTERM");
    waits.push(new Promise((resolve) => desktopChild.once("exit", resolve)));
  }
  if (identityChild && !identityChild.killed) {
    identityChild.kill("SIGTERM");
    waits.push(new Promise((resolve) => identityChild.once("exit", resolve)));
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

  if (finalSignal) {
    process.removeAllListeners(finalSignal);
    process.kill(process.pid, finalSignal);
    return;
  }
  process.exit(exitCode);
}

async function main() {
  const resolvedDev = resolveDevScriptEnvironment({
    repoRoot,
    baseEnv: isolateDevShellFromParentRuntime(process.env),
  });
  const resolvedIdentity = resolveDevIdentityEnvironment(resolvedDev.env);
  const env = resolvedIdentity.env;
  const desktopEnv = resolveDevDesktopEnvironment(env);

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
    void (async () => {
      const runtimeOwnerKind = desktopStarted
        ? await waitForDesktopRuntimeOwnership(env)
        : null;
      const exitDisposition = classifyDevServerExit({ runtimeOwnerKind, shuttingDown });
      if (exitDisposition === "ignore") return;
      if (exitDisposition === "desktop-managed") {
        desktopOwnsRuntime = true;
        const outcome = signal ? `via ${signal}` : `with code ${code ?? 0}`;
        console.log(
          `[rudder:server] ${runtimeLabel} exited ${outcome}; Desktop now manages the local runtime.`,
        );
        return;
      }
      if (desktopChild && !desktopChild.killed) {
        desktopChild.kill("SIGTERM");
      }
      if (identityChild && !identityChild.killed) {
        identityChild.kill("SIGTERM");
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    })().catch((error) => {
      console.error(`[rudder:server] failed to classify ${runtimeLabel} exit`, error);
      void shutdown(1);
    });
  });

  await waitForDevRuntimeReady(env);

  await runManagedCommand(
    "identity-core-build",
    pnpmBin,
    ["--filter", "@rudderhq/identity-core", "build"],
    env,
  );
  await runManagedCommand(
    "identity-db-build",
    pnpmBin,
    ["--filter", "@rudderhq/identity-db", "build"],
    env,
  );
  await runManagedCommand(
    "identity-migrate",
    pnpmBin,
    ["--filter", "@rudderhq/identity-db", "migrate"],
    env,
  );

  identityChild = spawnManagedChild(
    "identity",
    pnpmBin,
    ["--filter", "@rudderhq/identity", "dev"],
    env,
  );
  identityChild.once("exit", (code, signal) => {
    identityChild = null;
    if (shuttingDown) return;
    if (desktopChild && !desktopChild.killed) desktopChild.kill("SIGTERM");
    if (serverChild && !serverChild.killed) serverChild.kill("SIGTERM");
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  await waitForIdentityReady(resolvedIdentity.identityOrigin);
  console.log(
    `[rudder:identity] local façade ready at ${resolvedIdentity.identityOrigin} (${resolvedIdentity.rootAuthMode})`,
  );
  if (resolvedIdentity.mailbox) {
    console.log(
      `[rudder:identity] captured mailbox: ${resolvedIdentity.mailbox.url} (Bearer ${resolvedIdentity.mailbox.secret})`,
    );
  }

  desktopChild = spawnManagedChild(
    "desktop",
    pnpmBin,
    ["--filter", "@rudderhq/desktop", "dev"],
    desktopEnv,
  );
  desktopStarted = true;
  desktopChild.once("exit", (code, signal) => {
    desktopChild = null;
    const exitDisposition = classifyDevDesktopExit({ desktopOwnsRuntime, shuttingDown });
    if (exitDisposition === "ignore") return;
    if (exitDisposition === "exit-parent") {
      if (signal) {
        void shutdown(1, signal);
        return;
      }
      void shutdown(code ?? 0);
      return;
    }
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

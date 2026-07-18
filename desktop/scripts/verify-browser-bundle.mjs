import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function exists(filePath) {
  return await access(filePath).then(() => true).catch(() => false);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, received ${actual ?? "unknown"}`);
}

function packagedExecutableForServerPackage(serverPackageDir) {
  const resourcesDir = path.dirname(serverPackageDir);
  if (process.platform === "darwin") {
    return path.resolve(resourcesDir, "..", "MacOS", "Rudder");
  }
  if (process.platform === "win32") {
    return path.resolve(resourcesDir, "..", "Rudder.exe");
  }
  return path.resolve(resourcesDir, "..", "Rudder");
}

export async function verifyBrowserBundle(options) {
  const serverPackageDir = path.resolve(options.serverPackageDir);
  const cliEntry = path.resolve(options.cliEntry ?? path.join(serverPackageDir, "desktop-cli.js"));
  const serverManifest = await readJson(path.join(serverPackageDir, "package.json"));
  const cliManifest = await readJson(path.join(path.dirname(cliEntry), "rudder-cli-package.json"));
  const expectedVersion = options.expectedVersion ?? serverManifest.version;
  assertEqual(serverManifest.name, "@rudderhq/server", "server package name");
  assertEqual(serverManifest.version, expectedVersion, "server package version");
  assertEqual(cliManifest.name, "@rudderhq/cli", "Desktop CLI package name");
  assertEqual(cliManifest.version, expectedVersion, "Desktop CLI version");

  const runtimeUtilsDir = path.join(serverPackageDir, "node_modules", "@rudderhq", "agent-runtime-utils");
  const runtimeUtilsManifest = await readJson(path.join(runtimeUtilsDir, "package.json"));
  assertEqual(runtimeUtilsManifest.version, expectedVersion, "agent-runtime-utils version");
  for (const packageName of [
    "agent-runtime-codex-local",
    "agent-runtime-claude-local",
    "agent-runtime-opencode-local",
    "agent-runtime-pi-local",
  ]) {
    const manifest = await readJson(path.join(serverPackageDir, "node_modules", "@rudderhq", packageName, "package.json"));
    assertEqual(manifest.version, expectedVersion, `${packageName} version`);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rudder-browser-bundle-"));
  const runtimeCacheDir = path.join(tempRoot, "runtimes", expectedVersion);
  const runtimeModuleDir = path.join(runtimeCacheDir, "node_modules", "@rudderhq", "agent-runtime-utils", "dist");
  const staleBinDir = path.join(tempRoot, "stale-bin");
  const staleMarker = path.join(tempRoot, "stale-path-invoked");
  const staleCommand = path.join(staleBinDir, process.platform === "win32" ? "rudder.cmd" : "rudder");

  try {
    const runtimePackageJson = path.join(runtimeCacheDir, "package.json");
    const runtimeScopeDir = path.join(runtimeCacheDir, "node_modules", "@rudderhq");
    await mkdir(runtimeScopeDir, { recursive: true });
    await writeFile(runtimePackageJson, `${JSON.stringify({
      private: true,
      dependencies: { "@rudderhq/server": expectedVersion },
    })}\n`, "utf8");
    await symlink(serverPackageDir, path.join(runtimeScopeDir, "server"), process.platform === "win32" ? "junction" : "dir");
    await symlink(runtimeUtilsDir, path.dirname(runtimeModuleDir), process.platform === "win32" ? "junction" : "dir");
    await writeFile(path.join(runtimeCacheDir, "runtime.json"), `${JSON.stringify({
      version: 1,
      packageName: "@rudderhq/server",
      packageVersion: expectedVersion,
      installedAt: new Date(0).toISOString(),
    })}\n`, "utf8");
    const externalServerEntrypoint = createRequire(runtimePackageJson).resolve("@rudderhq/server");
    if (!(await exists(externalServerEntrypoint))) {
      throw new Error(`external runtime server entrypoint is missing: ${externalServerEntrypoint}`);
    }
    await mkdir(staleBinDir, { recursive: true });
    await writeFile(
      staleCommand,
      process.platform === "win32"
        ? `@echo off\r\necho stale>${staleMarker}\r\nexit /b 2\r\n`
        : `#!/bin/sh\nprintf stale > '${staleMarker.replaceAll("'", "'\\''")}'\nexit 2\n`,
      "utf8",
    );
    await chmod(staleCommand, 0o755);

    const previousDesktopCliEntry = process.env.RUDDER_DESKTOP_CLI_ENTRY;
    process.env.RUDDER_DESKTOP_CLI_ENTRY = cliEntry;
    try {
      const resolver = await import(pathToFileURL(path.join(runtimeUtilsDir, "dist", "rudder-mcp-server.js")).href);
      const preflightModule = await import(pathToFileURL(path.join(runtimeUtilsDir, "dist", "rudder-mcp-preflight.js")).href);
      const contractModule = await import(pathToFileURL(path.join(runtimeUtilsDir, "dist", "rudder-mcp-contract.js")).href);
      const command = await resolver.resolveRudderMcpCliCommand(runtimeModuleDir);
      assertEqual(command.provenance, "desktop_bundle", "resolver provenance");
      assertEqual(command.expectedVersion, expectedVersion, "resolver expected version");
      const expectedArgs = process.platform === "win32"
        ? [path.join(path.dirname(cliEntry), "desktop-cli-runner.js"), "mcp-server"]
        : ["--desktop-cli", "mcp-server"];
      assertEqual(JSON.stringify(command.args), JSON.stringify(expectedArgs), "resolver arguments");
      if (process.platform === "win32") {
        assertEqual(command.env?.ELECTRON_RUN_AS_NODE, "1", "resolver Electron Node mode");
      }
      const packagedExecutable = options.desktopExecutable
        ? path.resolve(options.desktopExecutable)
        : packagedExecutableForServerPackage(path.dirname(cliEntry));
      if (!(await exists(packagedExecutable))) {
        throw new Error(`packaged Desktop executable is missing: ${packagedExecutable}`);
      }
      const packagedCommand = {
        ...command,
        command: packagedExecutable,
        args: process.platform === "linux" ? ["--no-sandbox", ...command.args] : command.args,
      };
      const result = await preflightModule.preflightRudderMcpServer({
        command: packagedCommand,
        runtimeEnv: {
          ...process.env,
          HOME: tempRoot,
          PATH: [staleBinDir, process.env.PATH].filter(Boolean).join(path.delimiter),
          RUDDER_BROWSER_ENABLED: "true",
          RUDDER_DESKTOP_DISABLE_CLI_LINK: "1",
        },
        browserEnabled: true,
        timeoutMs: 15_000,
      });
      if (!result.available || !result.browserAvailable) {
        throw new Error(
          `packaged Browser MCP preflight failed: ${result.diagnosticCode ?? "unknown"}: ${result.diagnostic ?? "no diagnostic"}`,
        );
      }
      assertEqual(result.version, expectedVersion, "handshake CLI version");
      assertEqual(result.contractVersion, contractModule.RUDDER_MCP_CONTRACT_VERSION, "handshake contract version");
      assertEqual(result.coreContractHash, contractModule.RUDDER_CORE_MCP_CONTRACT_HASH, "handshake core contract hash");
      assertEqual(result.contractHash, contractModule.RUDDER_BROWSER_MCP_CONTRACT_HASH, "handshake Browser contract hash");
      const browserTools = result.tools.map((tool) => tool.name).filter((name) => name.startsWith("rudder_browser_"));
      assertEqual(JSON.stringify(browserTools), JSON.stringify(contractModule.RUDDER_BROWSER_MCP_TOOL_NAMES), "Browser tool set");
      if (await exists(staleMarker)) throw new Error("packaged Browser bundle resolved the stale PATH rudder command");
      return {
        version: result.version,
        contractHash: result.contractHash,
        provenance: result.provenance,
        browserTools,
        packagedExecutable,
      };
    } finally {
      if (previousDesktopCliEntry === undefined) delete process.env.RUDDER_DESKTOP_CLI_ENTRY;
      else process.env.RUDDER_DESKTOP_CLI_ENTRY = previousDesktopCliEntry;
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const serverPackageDir = process.argv.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length);
  const cliEntry = process.argv.find((arg) => arg.startsWith("--cli-entry="))?.slice("--cli-entry=".length);
  const expectedVersion = process.argv.find((arg) => arg.startsWith("--expected-version="))?.slice("--expected-version=".length);
  const desktopExecutable = process.argv.find((arg) => arg.startsWith("--desktop-executable="))?.slice("--desktop-executable=".length);
  if (!serverPackageDir) throw new Error("Usage: verify-browser-bundle.mjs --dir=<server-package> [--cli-entry=<desktop-cli.js>]");
  const result = await verifyBrowserBundle({ serverPackageDir, cliEntry, expectedVersion, desktopExecutable });
  console.log(`[verify-browser-bundle] version=${result.version} provenance=${result.provenance} contract=${result.contractHash} tools=${result.browserTools.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error("[verify-browser-bundle] failed", error);
    process.exit(1);
  });
}

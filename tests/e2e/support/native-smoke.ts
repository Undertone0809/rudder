import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePostgresRuntimeDirectory } from "../../../packages/db/src/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let binariesBuild: Promise<void> | undefined;

function buildNativeChatBinaries() {
  if (!binariesBuild) {
    binariesBuild = new Promise<void>((resolve, reject) => {
      const child = spawn("cargo", [
        "build",
        "--locked",
        "--manifest-path",
        "native/Cargo.toml",
        "-p",
        "rudder-server-foundation-core",
        "-p",
        "rudder-server-foundation",
        "-p",
        "rudder-process-host",
        "--bins",
        "--example",
        "native_chat_browser_fixture",
      ], {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk: Buffer) => { output = `${output}${chunk}`.slice(-20_000); });
      }
      child.once("error", (error) => reject(new Error(`Could not start the Native Chat fixture build: ${error.message}`, { cause: error })));
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Native Chat fixture build failed (exit=${code ?? "none"}, signal=${signal ?? "none"}):\n${output}`));
      });
    });
  }
  return binariesBuild;
}

async function resolveBinary(envName: string, relativePath: string) {
  const configured = process.env[envName]?.trim();
  const binary = configured ? path.resolve(configured) : path.join(REPO_ROOT, relativePath);
  try {
    await access(binary);
  } catch {
    throw new Error(`${envName} must point to an existing binary; checked ${binary}`);
  }
  return binary;
}

/** Resolve the real Rust browser fixture and its disposable PostgreSQL runtime. */
export async function nativeSmokeFixtureOptions() {
  const configuredExample = process.env.RUDDER_NATIVE_CHAT_E2E_EXAMPLE?.trim();
  if (!configuredExample) await buildNativeChatBinaries();

  const exampleBinary = await resolveBinary(
    "RUDDER_NATIVE_CHAT_E2E_EXAMPLE",
    "native/target/debug/examples/native_chat_browser_fixture",
  );
  const processHost = await resolveBinary("RUDDER_TEST_PROCESS_HOST", "native/target/debug/rudder-process-host");
  const foundationBinary = await resolveBinary("RUDDER_SERVER_FOUNDATION_PATH", "native/target/debug/rudder-server-foundation");
  const postgresBinDir = resolvePostgresRuntimeDirectory();
  for (const executable of ["initdb", "pg_ctl"]) {
    try {
      await access(path.join(postgresBinDir, executable));
    } catch {
      throw new Error(`PostgreSQL runtime is missing ${executable}: ${postgresBinDir}`);
    }
  }

  return { exampleBinary, processHost, foundationBinary, postgresBinDir };
}

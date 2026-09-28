import { chmodSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST_TARGETS = Object.freeze({
  "darwin/arm64": "aarch64-apple-darwin",
  "darwin/x64": "x86_64-apple-darwin",
  "linux/arm64": "aarch64-unknown-linux-gnu",
  "linux/x64": "x86_64-unknown-linux-gnu",
});

export function restoreFoundationExecutableMode({
  resourcesDir = path.dirname(fileURLToPath(import.meta.url)),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform === "win32") return { status: "not_required" };
  const target = HOST_TARGETS[`${platform}/${arch}`];
  if (!target) return { status: "unsupported" };

  const binaryPath = path.join(resourcesDir, "native", target, "rudder-server-foundation");
  let stat;
  try {
    stat = lstatSync(binaryPath);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing", target };
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Server foundation payload is not a regular file: ${binaryPath}`);
  chmodSync(binaryPath, stat.mode | 0o111);
  return { status: "restored", target, path: binaryPath };
}

restoreFoundationExecutableMode();

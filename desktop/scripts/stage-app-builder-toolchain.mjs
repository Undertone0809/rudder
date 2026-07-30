import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const sourceRoot = path.join(desktopRoot, "node_modules", "pnpm");
const destinationRoot = path.join(desktopRoot, "dist", "toolchain", "pnpm");
const nodeBinRoot = path.join(desktopRoot, "dist", "toolchain", "node", "bin");
const posixNodeShim = `#!/bin/sh
if [ -z "\${RUDDER_APP_BUILDER_NODE_EXECUTABLE:-}" ]; then
  echo "Rudder App Builder Node runtime is unavailable" >&2
  exit 1
fi
export ELECTRON_RUN_AS_NODE=1
exec "$RUDDER_APP_BUILDER_NODE_EXECUTABLE" "$@"
`;
const windowsNodeShim = `@echo off\r
if not defined RUDDER_APP_BUILDER_NODE_EXECUTABLE (\r
  echo Rudder App Builder Node runtime is unavailable 1>&2\r
  exit /b 1\r
)\r
set ELECTRON_RUN_AS_NODE=1\r
"%RUDDER_APP_BUILDER_NODE_EXECUTABLE%" %*\r
`;

async function main() {
  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.rm(path.dirname(nodeBinRoot), { recursive: true, force: true });
  await fs.mkdir(path.dirname(destinationRoot), { recursive: true });
  await fs.cp(sourceRoot, destinationRoot, {
    recursive: true,
    dereference: true,
  });
  await fs.mkdir(nodeBinRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(nodeBinRoot, "node"), posixNodeShim, { mode: 0o755 }),
    fs.writeFile(path.join(nodeBinRoot, "node.cmd"), windowsNodeShim),
  ]);

  await fs.access(path.join(destinationRoot, "bin", "pnpm.cjs"));
  await fs.access(path.join(destinationRoot, "dist", "pnpm.cjs"));
  await fs.access(path.join(nodeBinRoot, process.platform === "win32" ? "node.cmd" : "node"));
}

void main().catch((error) => {
  console.error("[desktop:toolchain] failed to stage managed pnpm", error);
  process.exit(1);
});

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const staleWorkspaceServerLink = path.join(desktopRoot, "node_modules", "@rudder", "server");
const staleWorkspaceCliLink = path.join(desktopRoot, "node_modules", "@rudder", "cli");
const rudderScopeDir = path.dirname(staleWorkspaceServerLink);

async function main() {
  await fs.rm(staleWorkspaceServerLink, { recursive: true, force: true });
  await fs.rm(staleWorkspaceCliLink, { recursive: true, force: true });

  try {
    const remainingEntries = await fs.readdir(rudderScopeDir);
    if (remainingEntries.length === 0) {
      await fs.rmdir(rudderScopeDir);
    }
  } catch {
    // Ignore: the scope directory is optional and may not exist.
  }
}

void main().catch((error) => {
  console.error("[desktop:prune-packaging-node-modules] failed to prune stale workspace links", error);
  process.exit(1);
});

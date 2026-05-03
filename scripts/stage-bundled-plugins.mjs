import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const bundledPlugins = [
  {
    source: "packages/plugins/examples/plugin-linear",
    destination: "server/dist/bundled-plugins/plugin-linear",
    files: ["package.json", "README.md", "dist"],
  },
];

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function stagePlugin(plugin) {
  const sourceRoot = path.resolve(repoRoot, plugin.source);
  const destinationRoot = path.resolve(repoRoot, plugin.destination);

  if (!(await pathExists(sourceRoot))) {
    throw new Error(`Bundled plugin source not found: ${sourceRoot}`);
  }

  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.mkdir(destinationRoot, { recursive: true });

  for (const file of plugin.files) {
    const sourcePath = path.join(sourceRoot, file);
    if (!(await pathExists(sourcePath))) {
      throw new Error(`Bundled plugin file not found: ${sourcePath}`);
    }
    await fs.cp(sourcePath, path.join(destinationRoot, file), { recursive: true });
  }
}

async function main() {
  for (const plugin of bundledPlugins) {
    await stagePlugin(plugin);
  }
}

void main().catch((error) => {
  console.error("[stage-bundled-plugins] failed", error);
  process.exit(1);
});

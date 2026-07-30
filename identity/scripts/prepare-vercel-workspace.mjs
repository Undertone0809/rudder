import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function addDefaultExportCondition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;

  for (const entry of Object.values(value)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (entry.import && !entry.default) entry.default = entry.import;
      addDefaultExportCondition(entry);
    }
  }
}

export function createDeploymentManifest(manifest) {
  if (!manifest.publishConfig) {
    throw new Error(`${manifest.name ?? "workspace package"} is missing publishConfig`);
  }

  const next = structuredClone(manifest);
  if (manifest.publishConfig.exports) {
    next.exports = structuredClone(manifest.publishConfig.exports);
    addDefaultExportCondition(next.exports);
  }
  if (manifest.publishConfig.main) next.main = manifest.publishConfig.main;
  if (manifest.publishConfig.types) next.types = manifest.publishConfig.types;
  return next;
}

export async function prepareVercelWorkspace({
  env = process.env,
  packagePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../packages/identity-core/package.json",
  ),
} = {}) {
  if (env.VERCEL !== "1") return false;

  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  const deploymentManifest = createDeploymentManifest(manifest);
  await writeFile(packagePath, `${JSON.stringify(deploymentManifest, null, 2)}\n`, "utf8");
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareVercelWorkspace();
}

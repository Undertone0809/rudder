import fs from "node:fs/promises";
import path from "node:path";

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function stripTypeExportConditions(value) {
  if (Array.isArray(value)) return value.map(stripTypeExportConditions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "types" && !key.startsWith("types@"))
      .map(([key, child]) => [key, stripTypeExportConditions(child)]),
  );
}

function addDefaultExportCondition(exportsObj) {
  if (typeof exportsObj !== "object" || exportsObj === null || Array.isArray(exportsObj)) {
    return;
  }
  for (const key of Object.keys(exportsObj)) {
    const entry = exportsObj[key];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (entry.import && !entry.default) {
        entry.default = entry.import;
      }
      addDefaultExportCondition(entry);
    }
  }
}

async function writeFileBreakingLinks(filePath, content) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function rewriteInternalPackageManifest(packageDir, { includeTypes = true } = {}) {
  const manifestPath = path.join(packageDir, "package.json");
  if (!(await exists(manifestPath))) return;

  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  if (
    !manifest.name?.startsWith?.("@rudderhq/")
    && !manifest.name?.startsWith?.("@rudder/")
  ) return;
  if (!manifest.publishConfig) return;

  const nextManifest = {
    ...manifest,
  };

  if (manifest.publishConfig.exports) {
    nextManifest.exports = JSON.parse(JSON.stringify(manifest.publishConfig.exports));
    if (!includeTypes) {
      nextManifest.exports = stripTypeExportConditions(nextManifest.exports);
    }
    addDefaultExportCondition(nextManifest.exports);
  }
  if (manifest.publishConfig.main) {
    nextManifest.main = manifest.publishConfig.main;
  }
  if (includeTypes && manifest.publishConfig.types) {
    nextManifest.types = manifest.publishConfig.types;
  } else if (!includeTypes) {
    delete nextManifest.types;
    delete nextManifest.typings;
    delete nextManifest.typesVersions;
  }

  await writeFileBreakingLinks(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
}

import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

function isWithin(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function verifyDesktopIdentityPackage(appDir) {
  const root = await realpath(appDir);
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.dependencies?.["@rudderhq/identity-core"]) {
    throw new Error("Desktop app manifest omits @rudderhq/identity-core");
  }
  const packageRoot = await realpath(path.join(root, "node_modules", "@rudderhq", "identity-core"));
  const resolved = await realpath(createRequire(manifestPath).resolve("@rudderhq/identity-core/electron"));
  if (!isWithin(root, packageRoot) || !isWithin(packageRoot, resolved)) {
    throw new Error("Desktop identity-core resolves outside the packaged app");
  }
  const identity = await import(pathToFileURL(resolved).href);
  if (identity.normalizeVerifiedEmail(" Smoke@Example.COM ") !== "smoke@example.com") {
    throw new Error("Desktop identity-core Electron entry is not loadable");
  }
}

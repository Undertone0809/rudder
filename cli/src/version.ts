import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  name?: string;
  version?: string;
};

const CLI_PACKAGE_NAME = "@rudderhq/cli";
const CLI_VERSION_MANIFEST = "rudder-cli-package.json";

function readPackageVersion(packagePath: string, expectedName: string): string | null {
  if (!existsSync(packagePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    if (parsed.name === expectedName && parsed.version) return parsed.version;
  } catch {
    return null;
  }

  return null;
}

export function resolveCliVersion(moduleUrl = import.meta.url, env: NodeJS.ProcessEnv = process.env): string {
  if (env.npm_package_name === CLI_PACKAGE_NAME && env.npm_package_version) {
    return env.npm_package_version;
  }

  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDir, CLI_VERSION_MANIFEST),
    path.resolve(moduleDir, "package.json"),
    path.resolve(moduleDir, "../package.json"),
    path.resolve(moduleDir, "../../package.json"),
  ];

  for (const candidate of candidates) {
    const version = readPackageVersion(candidate, CLI_PACKAGE_NAME);
    if (version) return version;
  }

  return "0.0.0";
}

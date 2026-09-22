import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export async function verifyShellIdentityDependency(appDir) {
  const root = await realpath(appDir);
  const requireFromApp = createRequire(path.join(root, "package.json"));
  const resolved = await realpath(requireFromApp.resolve("@rudderhq/identity-core/electron"));
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Desktop identity dependency resolves outside the packaged app: ${resolved}`);
  }
  if (!resolved.endsWith(".js")) {
    throw new Error(`Desktop identity dependency must resolve to compiled JavaScript: ${resolved}`);
  }
  return resolved;
}

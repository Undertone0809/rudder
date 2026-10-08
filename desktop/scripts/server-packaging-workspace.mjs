import { dump, load } from "js-yaml";
import fs from "node:fs/promises";
import path from "node:path";

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies"];

export function serverPackagingLockfile(sourceLockfile) {
  if (String(sourceLockfile.lockfileVersion) !== "9.0" || !sourceLockfile.importers?.server) {
    throw new Error("Server packaging requires the repository's pnpm v9 workspace lockfile");
  }
  const lockfile = structuredClone(sourceLockfile);
  const sourceImporters = lockfile.importers;
  lockfile.importers = {};
  const pending = ["server"];
  const copied = new Set();
  const targetId = (id) => id === "server" ? "." : id;
  while (pending.length > 0) {
    const id = pending.shift();
    if (copied.has(id)) continue;
    if (!sourceImporters[id] || id === "." || id.startsWith("../") || path.posix.isAbsolute(id)) {
      throw new Error(`Invalid server workspace dependency: ${id}`);
    }
    copied.add(id);
    const importer = sourceImporters[id];
    for (const field of dependencyFields) {
      for (const dependency of Object.values(importer[field] ?? {})) {
        if (!dependency.version?.startsWith("link:")) continue;
        const dependencyId = path.posix.normalize(path.posix.join(id, dependency.version.slice(5)));
        pending.push(dependencyId);
        const relative = path.posix.relative(targetId(id), targetId(dependencyId)) || ".";
        dependency.version = `link:${relative}`;
      }
    }
    lockfile.importers[targetId(id)] = importer;
  }
  return { lockfile, workspaceIds: [...copied] };
}

async function copyPackageFiles(sourceDir, targetDir) {
  const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, "package.json"), "utf8"));
  if (!Array.isArray(manifest.files)) {
    throw new Error(`Packaged workspace must declare its files: ${manifest.name}`);
  }
  await fs.mkdir(targetDir, { recursive: true });
  const files = new Set(["package.json", ...manifest.files]);
  for (const entry of await fs.readdir(sourceDir)) {
    if (/^(?:readme|licen[cs]e|copying|notice|changelog)(?:\.|$)/i.test(entry)) files.add(entry);
  }
  for (const file of files) {
    // The workspace's publish lists are literal paths. Fail closed if a new
    // package needs npm's glob/negation semantics instead of silently omitting it.
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || /[*!?\[\]{}]/.test(file)) {
      throw new Error(`Unsupported package file path: ${manifest.name}: ${file}`);
    }
    const source = path.join(sourceDir, file);
    try {
      await fs.access(source);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    await fs.cp(source, path.join(targetDir, file), { recursive: true, dereference: true });
  }
  return manifest;
}

export async function prepareServerPackagingWorkspace(repoRoot, targetDir) {
  const sourceLockfile = load(await fs.readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"));
  const { lockfile, workspaceIds } = serverPackagingLockfile(sourceLockfile);
  const rootManifest = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const manifests = new Map();
  for (const id of workspaceIds) {
    const destination = id === "server" ? targetDir : path.join(targetDir, id);
    manifests.set(destination, await copyPackageFiles(path.join(repoRoot, id), destination));
  }
  // A normal frozen hoisted install reads the lockfile. pnpm's legacy deploy
  // disables it for hoisted layouts and re-resolves registry dependency ranges.
  await fs.writeFile(path.join(targetDir, "package.json"), `${JSON.stringify({
    ...manifests.get(targetDir),
    pnpm: rootManifest.pnpm,
    packageManager: rootManifest.packageManager,
  }, null, 2)}\n`);
  await fs.writeFile(path.join(targetDir, "pnpm-lock.yaml"), dump(lockfile, { lineWidth: -1 }));
  await fs.writeFile(path.join(targetDir, "pnpm-workspace.yaml"), dump({
    packages: workspaceIds.filter((id) => id !== "server"),
  }));
  await fs.writeFile(path.join(targetDir, ".npmrc"), `auto-install-peers=${lockfile.settings.autoInstallPeers}\n`);
  for (const patch of Object.values(lockfile.patchedDependencies ?? {})) {
    if (path.isAbsolute(patch.path) || patch.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Invalid workspace patch path: ${patch.path}`);
    }
    await fs.mkdir(path.dirname(path.join(targetDir, patch.path)), { recursive: true });
    await fs.copyFile(path.join(repoRoot, patch.path), path.join(targetDir, patch.path));
  }
  return manifests;
}

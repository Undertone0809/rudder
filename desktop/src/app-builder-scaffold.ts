import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  copyDirectoryWithoutLinks,
  DEFAULT_SAFE_TREE_LIMITS,
  type SafeTreeLimits,
} from "./app-builder-file-tree.js";
import {
  APP_BUILDER_MANIFEST_FILENAME,
  normalizeAppBuilderRelativePath,
  parseAppBuilderManifest,
  resolveAppBuilderPath,
  type AppBuilderManifest,
} from "./app-builder-manifest.js";

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const GENERATED_SCAFFOLD_ROOTS = new Set([
  ".next",
  ".pnpm-store",
  "node_modules",
  "playwright-report",
  "test-results",
]);

function includeOfficialScaffoldEntry(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const root = normalized.split("/")[0] ?? "";
  if (GENERATED_SCAFFOLD_ROOTS.has(root)) return false;
  if (normalized.endsWith(".tsbuildinfo")) return false;
  if (root === "data" && normalized !== "data" && normalized !== "data/.gitkeep") {
    return false;
  }
  return true;
}

export interface CopyOfficialAppBuilderScaffoldOptions {
  templateRoot: string;
  workspaceRoot: string;
  targetDirectory: string;
  limits?: SafeTreeLimits;
  manifest?: AppBuilderManifest;
}

export async function copyOfficialAppBuilderScaffold(
  options: CopyOfficialAppBuilderScaffoldOptions,
): Promise<{ appRoot: string; entries: number; bytes: number }> {
  const templateInputStat = await lstat(options.templateRoot);
  if (templateInputStat.isSymbolicLink() || !templateInputStat.isDirectory()) {
    throw new Error("official template root must be a regular directory");
  }
  const templateRoot = await realpath(options.templateRoot);
  const manifest = options.manifest
    ? parseAppBuilderManifest(options.manifest)
    : undefined;
  const workspaceRoot = await realpath(options.workspaceRoot);
  if (!(await stat(templateRoot)).isDirectory() || !(await stat(workspaceRoot)).isDirectory()) {
    throw new Error("template and workspace roots must be directories");
  }

  const relativeTarget = normalizeAppBuilderRelativePath(
    options.targetDirectory,
    "target directory",
  );
  const targetRoot = path.resolve(workspaceRoot, ...relativeTarget.split("/"));
  if (!isInside(workspaceRoot, targetRoot) || targetRoot === workspaceRoot) {
    throw new Error("target directory must stay below the workspace root");
  }
  if (isInside(templateRoot, targetRoot) || isInside(targetRoot, templateRoot)) {
    throw new Error("template and target directories must not overlap");
  }

  const relativeParent = path.posix.dirname(relativeTarget);
  const targetParent = await resolveAppBuilderPath(
    workspaceRoot,
    relativeParent,
    { allowDot: true },
  );
  await mkdir(targetParent, { recursive: true });
  const canonicalParent = await realpath(targetParent);
  if (!isInside(workspaceRoot, canonicalParent)) {
    throw new Error("target directory resolves through a symlink outside the workspace");
  }

  let targetExisted = false;
  try {
    const targetStat = await lstat(targetRoot);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new Error("target path must be a directory");
    }
    if ((await readdir(targetRoot)).length > 0) {
      throw new Error("target directory must be empty");
    }
    targetExisted = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const stagingRoot = await mkdtemp(path.join(canonicalParent, ".rudder-app-builder-"));
  await rm(stagingRoot, { recursive: true, force: true });
  let copied: { entries: number; bytes: number } | undefined;
  try {
    copied = await copyDirectoryWithoutLinks(
      templateRoot,
      stagingRoot,
      options.limits ?? {
        ...DEFAULT_SAFE_TREE_LIMITS,
        maxEntries: 8_192,
        maxBytes: 1024 * 1024 * 1024,
      },
      includeOfficialScaffoldEntry,
    );
    if (copied.entries < 1) {
      throw new Error("official scaffold is empty");
    }
    if (manifest) {
      await writeFile(
        path.join(stagingRoot, APP_BUILDER_MANIFEST_FILENAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "w" },
      );
      const packagePath = path.join(stagingRoot, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
      if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
        throw new Error("official scaffold package.json is invalid");
      }
      await writeFile(
        packagePath,
        `${JSON.stringify({ ...packageJson, name: manifest.app.slug }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "w" },
      );
    }
    if (await realpath(targetParent) !== canonicalParent) {
      throw new Error("target parent changed while the scaffold was being prepared");
    }
    if (targetExisted) {
      await rmdir(targetRoot);
    }
    await rename(stagingRoot, targetRoot);
    return { appRoot: targetRoot, ...copied };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    if (targetExisted) {
      try {
        await mkdir(targetRoot);
      } catch {
        // Preserve the original failure. A concurrent writer may now own the path.
      }
    }
    throw error;
  }
}

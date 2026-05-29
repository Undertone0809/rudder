#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/collect-desktop-release-assets.mjs --version <version> --platform <macos|windows|linux> --arch <x64|arm64> --out <dir>",
      "",
    ].join("\n"),
  );
}

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function expectedExtension(platform) {
  if (platform === "macos") return ".zip";
  if (platform === "windows") return ".zip";
  if (platform === "linux") return ".AppImage";
  throw new Error(`Unsupported desktop platform: ${platform}`);
}

function expectedPortableAssetName(version, platform, arch) {
  if (platform === "linux") return `Rudder-${version}-${platform}-${arch}.AppImage`;
  return `Rudder-${version}-${platform}-${arch}-portable.zip`;
}

function expectedShellAssetName(version, platform, arch) {
  return `Rudder-${version}-${platform}-${arch}-shell.zip`;
}

function walkFiles(dir) {
  const files = [];
  const pending = [dir];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !existsSync(current)) continue;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (entry.isFile()) files.push(fullPath);
    }
  }

  return files;
}

function findDesktopAsset(releaseDir, platform, arch, version) {
  const files = walkFiles(releaseDir);
  const exactName = expectedPortableAssetName(version, platform, arch);
  const exactMatch = files.find((filePath) => path.basename(filePath) === exactName);
  if (exactMatch) return exactMatch;

  if (platform === "linux") {
    const candidates = files
      .filter((filePath) => {
        const base = path.basename(filePath);
        if (base.includes("blockmap")) return false;
        if (base.startsWith("builder-")) return false;
        return base.endsWith(".AppImage");
      })
      .sort((a, b) => a.localeCompare(b));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new Error(
        `Found multiple Linux AppImage artifacts under ${releaseDir}; expected ${exactName}: ${candidates.map((candidate) => path.basename(candidate)).join(", ")}`,
      );
    }
  }

  throw new Error(`Missing expected desktop artifact ${exactName} under ${releaseDir}`);
}

function findShellDesktopAsset(releaseDir, platform, arch, version) {
  if (platform !== "macos" && platform !== "windows") return null;
  const exactName = expectedShellAssetName(version, platform, arch);
  return walkFiles(releaseDir).find((filePath) => path.basename(filePath) === exactName) ?? null;
}

function main() {
  const args = readArgs(process.argv.slice(2));
  const version = args.version;
  const platform = args.platform;
  const arch = args.arch;
  const outDir = args.out;

  if (!version || !platform || !arch || !outDir) {
    usage();
    process.exit(1);
  }

  const releaseDir = path.join(repoRoot, "desktop", "release");
  const source = findDesktopAsset(releaseDir, platform, arch, version);
  const extension = expectedExtension(platform);
  const outputDir = path.resolve(repoRoot, outDir);
  const portableSuffix = platform === "linux" ? "" : "-portable";
  const outputName = `Rudder-${version}-${platform}-${arch}${portableSuffix}${extension}`;
  const outputPath = path.join(outputDir, outputName);

  mkdirSync(outputDir, { recursive: true });
  copyFileSync(source, outputPath);
  console.log(outputPath);

  const shellSource = findShellDesktopAsset(releaseDir, platform, arch, version);
  if (platform === "macos" || platform === "windows") {
    if (!shellSource) {
      throw new Error(`Missing expected Desktop shell artifact ${expectedShellAssetName(version, platform, arch)} under ${releaseDir}`);
    }
    const shellOutputPath = path.join(outputDir, expectedShellAssetName(version, platform, arch));
    copyFileSync(shellSource, shellOutputPath);
    console.log(shellOutputPath);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

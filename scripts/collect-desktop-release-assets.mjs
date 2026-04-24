#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
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
  if (platform === "macos") return ".dmg";
  if (platform === "windows") return ".exe";
  if (platform === "linux") return ".AppImage";
  throw new Error(`Unsupported desktop platform: ${platform}`);
}

function walkFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }
    if (entry.isFile()) files.push(fullPath);
  }

  return files;
}

function findDesktopAsset(releaseDir, platform) {
  const extension = expectedExtension(platform);
  const candidates = walkFiles(releaseDir)
    .filter((filePath) => {
      const base = path.basename(filePath);
      if (base.includes("blockmap")) return false;
      if (base.startsWith("builder-")) return false;
      return base.endsWith(extension);
    })
    .map((filePath) => ({ filePath, size: statSync(filePath).size }))
    .sort((a, b) => b.size - a.size || a.filePath.localeCompare(b.filePath));

  const match = candidates[0];
  if (!match) {
    throw new Error(`No ${extension} desktop artifact found under ${releaseDir}`);
  }
  return match.filePath;
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
  const source = findDesktopAsset(releaseDir, platform);
  const extension = expectedExtension(platform);
  const outputDir = path.resolve(repoRoot, outDir);
  const outputName = `Rudder-${version}-${platform}-${arch}${extension}`;
  const outputPath = path.join(outputDir, outputName);

  mkdirSync(outputDir, { recursive: true });
  copyFileSync(source, outputPath);
  console.log(outputPath);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const stagedServerPackageDir = path.join(repoRoot, "desktop", ".packaged", "server-package");
const stagedCliEntry = path.join(stagedServerPackageDir, "desktop-cli.js");
const stagedCommanderDir = path.join(stagedServerPackageDir, "node_modules", "commander");
const sourceCommanderDir = path.join(repoRoot, "cli", "node_modules", "commander");

const serverRuntimeExternals = [
  "@aws-sdk/client-s3",
  "@rudderhq/agent-runtime-claude-local",
  "@rudderhq/agent-runtime-codex-local",
  "@rudderhq/agent-runtime-cursor-local",
  "@rudderhq/agent-runtime-gemini-local",
  "@rudderhq/agent-runtime-openclaw-gateway",
  "@rudderhq/agent-runtime-opencode-local",
  "@rudderhq/agent-runtime-pi-local",
  "@rudderhq/agent-runtime-utils",
  "@rudderhq/db",
  "@rudderhq/plugin-sdk",
  "@rudderhq/server",
  "@rudderhq/shared",
  "ajv",
  "ajv-formats",
  "better-auth",
  "chokidar",
  "commander",
  "detect-port",
  "dompurify",
  "dotenv",
  "drizzle-orm",
  "embedded-postgres",
  "express",
  "hermes-paperclip-adapter",
  "jsdom",
  "multer",
  "open",
  "pino",
  "pino-http",
  "pino-pretty",
  "sharp",
  "ws",
  "zod",
];

async function main() {
  await fs.access(path.join(stagedServerPackageDir, "package.json"));
  await fs.mkdir(path.dirname(stagedCliEntry), { recursive: true });
  await fs.mkdir(path.dirname(stagedCommanderDir), { recursive: true });
  await fs.rm(stagedCommanderDir, { recursive: true, force: true });
  await fs.cp(sourceCommanderDir, stagedCommanderDir, { recursive: true, dereference: true });

  /**
   * Bundle the CLI program into the staged server package so packaged Desktop
   * reuses the server runtime's node_modules instead of carrying a second full
   * copy under Resources/app.
   */
  await build({
    entryPoints: [path.join(repoRoot, "cli", "src", "program.ts")],
    outfile: stagedCliEntry,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    treeShaking: true,
    minify: true,
    sourcemap: false,
    legalComments: "none",
    external: serverRuntimeExternals,
  });
}

void main().catch((error) => {
  console.error("[desktop:stage-cli] failed to stage packaged desktop CLI", error);
  process.exit(1);
});

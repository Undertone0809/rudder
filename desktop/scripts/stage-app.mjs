import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const stagedAppDir = path.join(desktopRoot, ".packaged", "app");
const sourceDistDir = path.join(desktopRoot, "dist");

async function main() {
  await fs.rm(stagedAppDir, { recursive: true, force: true });
  await fs.mkdir(stagedAppDir, { recursive: true });
  await fs.cp(sourceDistDir, path.join(stagedAppDir, "dist"), { recursive: true });

  const appManifest = {
    name: "@rudder/desktop",
    version: "0.1.0",
    private: true,
    description: "Rudder Desktop local-first Electron shell",
    author: "Rudder",
    type: "module",
    main: "dist/main.js",
  };

  await fs.writeFile(
    path.join(stagedAppDir, "package.json"),
    `${JSON.stringify(appManifest, null, 2)}\n`,
    "utf8",
  );
}

void main().catch((error) => {
  console.error("[desktop:stage-app] failed to stage packaged desktop app", error);
  process.exit(1);
});

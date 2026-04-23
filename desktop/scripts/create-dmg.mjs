import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(desktopDir, "package.json");
const releaseDir = path.join(desktopDir, "release");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopDir,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function withMountedTemplate(templateDmgPath, callback) {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-dmg-template-mount."));
  try {
    await run("hdiutil", ["attach", templateDmgPath, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    await callback(mountPoint);
  } finally {
    await run("hdiutil", ["detach", mountPoint]).catch(() => {});
    await fs.rm(mountPoint, { recursive: true, force: true });
  }
}

async function copyTemplateAssets(outputPath, stageDir) {
  if (!(await exists(releaseDir))) return;

  const entries = await fs.readdir(releaseDir, { withFileTypes: true });
  const templateCandidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".dmg"))
    .map((entry) => path.join(releaseDir, entry.name))
    .filter((candidate) => candidate !== outputPath)
    .sort((left, right) => right.localeCompare(left));

  for (const templateDmgPath of templateCandidates) {
    try {
      await withMountedTemplate(templateDmgPath, async (mountPoint) => {
        for (const assetName of [".DS_Store", ".VolumeIcon.icns", ".background.tiff"]) {
          const sourcePath = path.join(mountPoint, assetName);
          if (await exists(sourcePath)) {
            await fs.copyFile(sourcePath, path.join(stageDir, assetName));
          }
        }
      });
      return;
    } catch {
      // Ignore bad templates and fall back to a plain DMG layout.
    }
  }
}

async function hideFinderSupportFiles(stageDir) {
  for (const assetName of [".DS_Store", ".VolumeIcon.icns", ".background.tiff"]) {
    const assetPath = path.join(stageDir, assetName);
    if (!(await exists(assetPath))) continue;
    await run("chflags", ["hidden", assetPath]);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("create-dmg.mjs only supports macOS");
  }

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const productName = packageJson.build?.productName ?? packageJson.productName ?? packageJson.name;
  const version = packageJson.version;
  const arch = process.arch;

  const appPath = path.join(releaseDir, `mac-${arch}`, `${productName}.app`);
  const outputPath = path.join(releaseDir, `${productName}-${version}-${arch}.dmg`);
  const blockmapPath = `${outputPath}.blockmap`;

  if (!(await exists(appPath))) {
    throw new Error(`packaged app not found: ${appPath}`);
  }

  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-dmg-stage."));
  try {
    await copyTemplateAssets(outputPath, stageDir);
    await hideFinderSupportFiles(stageDir);
    await fs.symlink("/Applications", path.join(stageDir, "Applications"));
    await run("ditto", [appPath, path.join(stageDir, `${productName}.app`)]);

    await fs.rm(outputPath, { force: true });
    await fs.rm(blockmapPath, { force: true });

    await run("hdiutil", [
      "create",
      "-volname",
      productName,
      "-srcfolder",
      stageDir,
      "-ov",
      "-format",
      "UDZO",
      outputPath,
    ]);
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("[desktop:create-dmg] failed to create DMG", error);
  process.exit(1);
});

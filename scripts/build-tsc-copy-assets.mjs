import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const cleanPaths = [];
const copyPairs = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (arg === "--clean") {
    const target = args[index + 1];
    if (!target) throw new Error("--clean requires a path");
    cleanPaths.push(target);
    index += 1;
    continue;
  }

  if (arg === "--copy") {
    const source = args[index + 1];
    const destination = args[index + 2];
    if (!source || !destination) throw new Error("--copy requires source and destination paths");
    copyPairs.push([source, destination]);
    index += 2;
    continue;
  }

  throw new Error(`Unknown argument: ${arg}`);
}

function run(command, runArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, runArgs, {
      stdio: "inherit",
      shell: process.platform === "win32",
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

async function main() {
  for (const cleanPath of cleanPaths) {
    await fs.rm(path.resolve(cleanPath), { recursive: true, force: true });
  }

  await run(process.platform === "win32" ? "tsc.cmd" : "tsc", []);

  for (const [source, destination] of copyPairs) {
    const sourcePath = path.resolve(source);
    const destinationPath = path.resolve(destination);
    await fs.rm(destinationPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.cp(sourcePath, destinationPath, { recursive: true });
  }
}

void main().catch((error) => {
  console.error("[build-tsc-copy-assets] failed", error);
  process.exit(1);
});

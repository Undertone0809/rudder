import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allProjects = [
  "packages/db",
  "packages/shared",
  "packages/agent-runtime-utils",
  "packages/agent-runtimes/claude-local",
  "packages/agent-runtimes/codex-local",
  "packages/agent-runtimes/cursor-local",
  "packages/agent-runtimes/gemini-local",
  "packages/agent-runtimes/opencode-local",
  "packages/agent-runtimes/pi-local",
  "server",
  "ui",
  "cli",
  "desktop",
  "scripts",
];
const requestedProjects = process.env.RUDDER_TEST_PROJECTS
  ?.split(",")
  .map((project) => project.trim())
  .filter(Boolean);
const projects = requestedProjects?.length ? requestedProjects : allProjects;
const unknownProjects = projects.filter((project) => !allProjects.includes(project));
if (unknownProjects.length > 0) {
  throw new Error(`Unknown test project(s): ${unknownProjects.join(", ")}`);
}
const forwardedArgs = process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== "--");
const activeChildren = new Set();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const child of activeChildren) child.kill(signal);
  });
}

function runProject(project, testFiles = []) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--root",
        project,
        "--config",
        "vitest.config.ts",
        "--maxWorkers",
        "4",
        "--testTimeout",
        "15000",
        ...testFiles,
        "--passWithNoTests",
        ...forwardedArgs,
      ],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    activeChildren.add(child);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChildren.delete(child);
      if (signal) {
        reject(new Error(`${project} tests terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${project} tests failed with exit code ${code ?? "unknown"}`));
        return;
      }
      resolveRun();
    });
  });
}

async function listTestFiles(directory, relativeDirectory = "") {
  const entries = await readdir(resolve(directory, relativeDirectory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".packaged") continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (relativePath.startsWith("resources/bundled-skills/app-builder/assets/scaffold/")) continue;
    if (entry.isDirectory()) {
      files.push(...await listTestFiles(directory, relativePath));
    } else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function runIsolatedProject(project, concurrency = 4) {
  const testFiles = await listTestFiles(resolve(repoRoot, project));
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, testFiles.length) }, async () => {
    while (nextIndex < testFiles.length) {
      const testFile = testFiles[nextIndex++];
      process.stdout.write(`\n[test:run] ${project}/${testFile}\n`);
      await runProject(project, [testFile]);
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

for (const project of projects) {
  process.stdout.write(`\n[test:run] ${project}\n`);
  if (project === "server") {
    await runIsolatedProject(project);
  } else {
    await runProject(project);
  }
}

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmCommand, pnpmSpawnShell } from "./package-manager-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmBin = pnpmCommand();
const pnpmShell = pnpmSpawnShell();
const allProjects = [
  "packages/db",
  "packages/shared",
  "packages/agent-runtime-utils",
  "packages/agent-runtimes/claude-local",
  "packages/agent-runtimes/codex-local",
  "packages/agent-runtimes/cursor-local",
  "packages/agent-runtimes/opencode-local",
  "packages/agent-runtimes/pi-local",
  "server",
  "ui",
  "cli",
  "desktop",
  "scripts",
];
const forwardedArgs = process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== "--");
const forwardedMaxWorkers = forwardedArgs.some(
  (arg) => arg === "--maxWorkers" || arg.startsWith("--maxWorkers="),
);
const activeChildren = new Set();
let receivedSignal;

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function resolveProcessExitCode(resultExitCode, signal = receivedSignal) {
  return signal ? signalExitCode(signal) : resultExitCode;
}

function throwIfInterrupted() {
  if (!receivedSignal) return;
  const error = new Error(`Test run interrupted by ${receivedSignal}`);
  error.exitCode = signalExitCode(receivedSignal);
  throw error;
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      receivedSignal = signal;
      process.exitCode = signalExitCode(signal);
      for (const child of activeChildren) child.kill(signal);
    });
  }
}

export function runProject(project, testFiles = [], { spawnChild = spawn } = {}) {
  return new Promise((resolveRun, reject) => {
    throwIfInterrupted();
    const child = spawnChild(
      pnpmBin,
      [
        "exec",
        "vitest",
        "run",
        "--root",
        project,
        "--config",
        "vitest.config.ts",
        ...(forwardedMaxWorkers ? [] : ["--maxWorkers", "4"]),
        "--testTimeout",
        "15000",
        ...testFiles,
        "--passWithNoTests",
        ...forwardedArgs,
      ],
      {
        cwd: repoRoot,
        env: process.env,
        shell: pnpmShell,
        stdio: "inherit",
      },
    );
    activeChildren.add(child);
    child.once("error", (error) => {
      activeChildren.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      activeChildren.delete(child);
      if (signal) {
        const error = new Error(`${project} tests terminated by ${signal}`);
        if (receivedSignal) error.exitCode = signalExitCode(receivedSignal);
        reject(error);
        return;
      }
      resolveRun({ code: code ?? 1 });
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

export async function runProjects(
  projects,
  {
    run = runProject,
    listFiles = (project) => listTestFiles(resolve(repoRoot, project)),
    write = (text) => process.stdout.write(text),
  } = {},
) {
  const failures = [];
  for (const project of projects) {
    throwIfInterrupted();
    write(`\n[test:run] ${project}\n`);
    if (project === "server") {
      const testFiles = await listFiles(project);
      for (const testFile of testFiles) {
        throwIfInterrupted();
        write(`\n[test:run] ${project}/${testFile}\n`);
        const { code } = await run(project, [testFile]);
        if (code !== 0) failures.push({ project, testFile, code });
      }
    } else {
      const { code } = await run(project);
      if (code !== 0) failures.push({ project, code });
    }
  }

  if (failures.length > 0) {
    const details = failures.map(({ project, testFile, code }) =>
      `  ${testFile ? `${project}/${testFile}` : project} (exit ${code})`
    );
    write(`\n[test:run] ${failures.length} Vitest command(s) failed:\n${details.join("\n")}\n`);
  }
  return { failures, exitCode: failures.length > 0 ? 1 : 0 };
}

async function main() {
  const requestedProjects = process.env.RUDDER_TEST_PROJECTS
    ?.split(",")
    .map((project) => project.trim())
    .filter(Boolean);
  const projects = requestedProjects?.length ? requestedProjects : allProjects;
  const unknownProjects = projects.filter((project) => !allProjects.includes(project));
  if (unknownProjects.length > 0) {
    throw new Error(`Unknown test project(s): ${unknownProjects.join(", ")}`);
  }

  installSignalHandlers();
  try {
    const result = await runProjects(projects);
    process.exitCode = resolveProcessExitCode(result.exitCode);
  } catch (error) {
    process.stderr.write(`[test:run] ${error.message}\n`);
    process.exitCode = error.exitCode ?? resolveProcessExitCode(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

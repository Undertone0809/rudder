#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/lint-imports.mjs [--fix] [--changed] [--skip-dirty]

Checks whether tracked JS/TS imports match TypeScript's organize-imports output.

Options:
  --fix         write organized imports back to disk
  --changed     only check tracked files changed in the working tree or index
  --skip-dirty  with --fix, skip files with uncommitted changes
`);
  process.exit(0);
}

const fix = args.has("--fix");
const changedOnly = args.has("--changed");
const skipDirty = args.has("--skip-dirty");
const configPath = path.join(root, ".lint-imports.json");
const ignoredFiles = new Set();

if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (Array.isArray(config.ignoredFiles)) {
    for (const file of config.ignoredFiles) {
      if (typeof file === "string") ignoredFiles.add(normalizeRelative(file));
    }
  }
}

function gitOutput(gitArgs) {
  return execFileSync("git", gitArgs, { cwd: root });
}

function splitNul(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function toAbsolute(filePath) {
  return path.join(root, filePath);
}

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join("/");
}

function isLintableFile(filePath) {
  const normalized = normalizeRelative(filePath);
  if (normalized.endsWith(".d.ts")) return false;
  if (normalized.includes("/dist/") || normalized.includes("/coverage/")) return false;
  if (normalized.includes("/.packaged/") || normalized.includes("/node_modules/")) return false;
  return /\.(c|m)?[jt]sx?$/.test(normalized);
}

function readTrackedFiles() {
  return splitNul(gitOutput(["ls-files", "-z"])).filter(isLintableFile);
}

function readChangedTrackedFiles() {
  const changed = new Set([
    ...splitNul(gitOutput(["diff", "--name-only", "-z", "--diff-filter=ACMR"])),
    ...splitNul(gitOutput(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])),
  ]);
  return [...changed].filter(isLintableFile);
}

function readDirtyTrackedFiles() {
  return new Set([
    ...splitNul(gitOutput(["diff", "--name-only", "-z", "--diff-filter=ACMR"])),
    ...splitNul(gitOutput(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])),
  ]);
}

const relativeFiles = (changedOnly ? readChangedTrackedFiles() : readTrackedFiles()).sort();
const dirtyFiles = skipDirty ? readDirtyTrackedFiles() : new Set();
const skippedDirty = [];
const files = [];

for (const relativeFile of relativeFiles) {
  if (fix && skipDirty && dirtyFiles.has(relativeFile)) {
    skippedDirty.push(relativeFile);
    continue;
  }
  const absoluteFile = toAbsolute(relativeFile);
  if (existsSync(absoluteFile)) files.push(absoluteFile);
}

if (files.length === 0) {
  const scope = changedOnly ? "changed tracked files" : "tracked JS/TS files";
  console.log(`lint-imports: no ${scope} to check.`);
  process.exit(0);
}

const compilerOptions = {
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  esModuleInterop: true,
  resolveJsonModule: true,
  isolatedModules: true,
  noEmit: true,
  baseUrl: root,
  paths: {
    "@/*": ["ui/src/*"],
  },
};

const fileVersions = new Map(files.map((file) => [file, "0"]));
const serviceHost = {
  getScriptFileNames: () => files,
  getScriptVersion: (fileName) => fileVersions.get(fileName) ?? "0",
  getScriptSnapshot: (fileName) => (
    existsSync(fileName)
      ? ts.ScriptSnapshot.fromString(readFileSync(fileName, "utf8"))
      : undefined
  ),
  getCurrentDirectory: () => root,
  getCompilationSettings: () => compilerOptions,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
  realpath: ts.sys.realpath,
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  getNewLine: () => "\n",
};

const formatOptions = {
  indentSize: 2,
  tabSize: 2,
  convertTabsToSpaces: true,
  newLineCharacter: "\n",
  insertSpaceAfterCommaDelimiter: true,
  insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
  semicolons: ts.SemicolonPreference.Insert,
};

const service = ts.createLanguageService(serviceHost, ts.createDocumentRegistry());
const needsOrganize = [];
const ignoredNeedsOrganize = [];

function applyTextChanges(text, changes) {
  let next = text;
  for (const change of [...changes].sort((a, b) => b.span.start - a.span.start)) {
    next = next.slice(0, change.span.start) + change.newText + next.slice(change.span.start + change.span.length);
  }
  return next;
}

for (const fileName of files) {
  const edits = service.organizeImports({ type: "file", fileName }, formatOptions, {});
  const changes = edits.flatMap((edit) => edit.textChanges);
  if (changes.length === 0) continue;

  const current = readFileSync(fileName, "utf8");
  const next = applyTextChanges(current, changes);
  if (next === current) continue;

  const relativeFile = normalizeRelative(path.relative(root, fileName));
  if (!fix && ignoredFiles.has(relativeFile)) {
    ignoredNeedsOrganize.push(relativeFile);
    continue;
  }
  needsOrganize.push(relativeFile);
  if (fix) writeFileSync(fileName, next);
}

if (skippedDirty.length > 0) {
  console.log(`lint-imports: skipped ${skippedDirty.length} dirty file(s):`);
  for (const file of skippedDirty) console.log(`  ${file}`);
}

if (needsOrganize.length === 0) {
  const ignoredSuffix = ignoredNeedsOrganize.length > 0
    ? ` (${ignoredNeedsOrganize.length} baseline file(s) ignored)`
    : "";
  console.log(`lint-imports: checked ${files.length} file(s); imports are organized${ignoredSuffix}.`);
  process.exit(0);
}

if (fix) {
  console.log(`lint-imports: organized imports in ${needsOrganize.length} file(s):`);
  for (const file of needsOrganize) console.log(`  ${file}`);
  process.exit(0);
}

console.error(`lint-imports: ${needsOrganize.length} file(s) need import organization:`);
for (const file of needsOrganize) console.error(`  ${file}`);
console.error("\nRun `pnpm lint:fix` to update imports.");
process.exit(1);

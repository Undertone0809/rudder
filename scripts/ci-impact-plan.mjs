#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const FULL_QUALIFICATION_FAMILIES = [
  "architecture",
  "docs",
  "verify",
  "native",
  "desktop",
];

const PATH_RULES = [
  ["workflow", (file) => file.startsWith(".github/") || file === "AGENTS.md"],
  ["release", (file) => file.startsWith("scripts/release") || file.startsWith("scripts/collect-desktop-release") || file.startsWith("scripts/publish-github-release")],
  ["lockfile", (file) => /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock)$/.test(file)],
  ["dependency-graph", (file) => file === "package.json" || file === "pnpm-workspace.yaml" || file.endsWith("/package.json")],
  ["shared", (file) => file.startsWith("packages/shared/")],
  ["db", (file) => file.startsWith("packages/db/") || /(?:^|\/)migrations\//.test(file)],
  ["native", (file) => file.startsWith("native/") || file.startsWith("packages/agent-runtime-utils/")],
  ["desktop", (file) => file.startsWith("desktop/")],
  ["ui", (file) => file.startsWith("ui/")],
  ["server", (file) => file.startsWith("server/")],
  ["cli", (file) => file.startsWith("cli/")],
  ["identity", (file) => file.startsWith("identity/") || file.startsWith("packages/identity/")],
  ["e2e", (file) => file.startsWith("tests/e2e/") || file.startsWith("tests/release-smoke/")],
  ["docs", (file) => file.startsWith("docs/") || file.startsWith("doc/") || /(?:^|\/)(?:README|CHANGELOG)(?:\.|$)/i.test(file)],
];

const HIGH_RISK_RULES = [
  ["workflow control files changed", (areas, files) => areas.has("workflow") || files.some((file) => file === "scripts/ci-impact-plan.mjs" || file === "scripts/ci-impact-plan.test.mjs")],
  ["release control files changed", (areas) => areas.has("release")],
  ["dependency resolution may affect the whole workspace", (areas) => areas.has("lockfile") || areas.has("dependency-graph")],
  ["shared contracts changed", (areas) => areas.has("shared")],
  ["database schema or migration changed", (areas) => areas.has("db")],
  ["native or Desktop packaging changed", (areas) => areas.has("native") || areas.has("desktop")],
  ["comparison scope is not bounded", (areas) => areas.has("other")],
];

function normalizePath(file) {
  const normalized = file.trim().replaceAll("\\", "/");
  if (!normalized || normalized === ".") return null;
  if (normalized.startsWith("/") || normalized.includes("../")) {
    throw new Error(`Changed path must be repository-relative: ${file}`);
  }
  return normalized.replace(/^\.\//, "");
}

export function normalizeChangedPaths(files) {
  return [...new Set(files.map(normalizePath).filter(Boolean))].sort();
}

function classifyChangedPaths(files) {
  const areas = new Set();
  for (const file of files) {
    const rule = PATH_RULES.find(([, matches]) => matches(file));
    areas.add(rule?.[0] ?? "other");
  }
  return areas;
}

function digestPlan(plan) {
  return createHash("sha256")
    .update(JSON.stringify(plan))
    .digest("hex");
}

function fullPlan({ profile, event, files, baseSha, headSha, headTreeSha, areas, reasons }) {
  return {
    profile,
    qualification: "full",
    event,
    sourceSha: headSha || "unknown",
    sourceTreeSha: headTreeSha || "unknown",
    comparisonSha: baseSha || "unknown",
    changedPaths: files,
    changedAreas: [...areas].sort(),
    requiredFamilies: [...FULL_QUALIFICATION_FAMILIES],
    affectedScopes: [...areas].sort(),
    escalationReasons: reasons,
    fullQualification: true,
  };
}

export function createImpactPlan({ event, files, baseSha = "", headSha = "", headTreeSha = "" }) {
  const normalizedEvent = String(event || "").trim();
  const changedPaths = normalizeChangedPaths(files);
  const areas = classifyChangedPaths(changedPaths);

  if (normalizedEvent === "merge_group") {
    return withDigest(fullPlan({
      profile: "merge_full",
      event: normalizedEvent,
      files: changedPaths,
      baseSha,
      headSha,
      headTreeSha,
      areas,
      reasons: ["merge queue candidates require exhaustive qualification"],
    }));
  }

  if (normalizedEvent === "workflow_dispatch") {
    return withDigest(fullPlan({
      profile: "exact_source",
      event: normalizedEvent,
      files: changedPaths,
      baseSha,
      headSha,
      headTreeSha,
      areas,
      reasons: ["trusted exact-source qualification was requested"],
    }));
  }

  if (normalizedEvent === "push") {
    return withDigest(fullPlan({
      profile: "main_attest",
      event: normalizedEvent,
      files: changedPaths,
      baseSha,
      headSha,
      headTreeSha,
      areas,
      reasons: ["integrated main commits require a complete qualification receipt"],
    }));
  }

  if (normalizedEvent !== "pull_request") {
    return withDigest(fullPlan({
      profile: "exact_source",
      event: normalizedEvent || "unknown",
      files: changedPaths,
      baseSha,
      headSha,
      headTreeSha,
      areas,
      reasons: ["unknown CI event must fail closed into full qualification"],
    }));
  }

  if (changedPaths.length === 0) {
    return withDigest(fullPlan({
      profile: "pr_affected",
      event: normalizedEvent,
      files: changedPaths,
      baseSha,
      headSha,
      headTreeSha,
      areas,
      reasons: ["changed-file scope is empty and cannot be bounded"],
    }));
  }

  const escalationReasons = HIGH_RISK_RULES
    .filter(([, matches]) => matches(areas, changedPaths))
    .map(([reason]) => reason);

  if (escalationReasons.length > 0) {
    return withDigest(fullPlan({
      profile: "pr_affected",
      event: normalizedEvent,
      files: changedPaths,
      baseSha,
      headSha,
      headTreeSha,
      areas,
      reasons: escalationReasons,
    }));
  }

  const requiredFamilies = ["architecture"];
  if (areas.size === 1 && areas.has("docs")) {
    requiredFamilies.push("docs");
  } else {
    requiredFamilies.push("affected");
    if (areas.has("docs")) requiredFamilies.push("docs");
  }

  return withDigest({
    profile: "pr_affected",
    qualification: "affected",
    event: normalizedEvent,
    sourceSha: headSha || "unknown",
    sourceTreeSha: headTreeSha || "unknown",
    comparisonSha: baseSha || "unknown",
    changedPaths,
    changedAreas: [...areas].sort(),
    requiredFamilies,
    affectedScopes: [...areas].sort(),
    escalationReasons: [],
    fullQualification: false,
  });
}

function withDigest(plan) {
  return { ...plan, planDigest: digestPlan(plan) };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) throw new Error(`Unknown argument: ${arg ?? ""}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function writeGithubOutputs(path, plan) {
  const outputs = {
    profile: plan.profile,
    qualification: plan.qualification,
    source_sha: plan.sourceSha,
    source_tree_sha: plan.sourceTreeSha,
    comparison_sha: plan.comparisonSha,
    changed_areas: plan.changedAreas.join(","),
    affected_scopes: plan.affectedScopes.join(","),
    required_families: plan.requiredFamilies.join(","),
    escalation_reasons: plan.escalationReasons.join("; "),
    full_qualification: String(plan.fullQualification),
    plan_digest: plan.planDigest,
    run_architecture: String(plan.requiredFamilies.includes("architecture")),
    run_affected: String(plan.requiredFamilies.includes("affected")),
    run_docs: String(plan.requiredFamilies.includes("docs")),
    run_verify: String(plan.requiredFamilies.includes("verify")),
    run_native: String(plan.requiredFamilies.includes("native")),
    run_desktop: String(plan.requiredFamilies.includes("desktop")),
  };
  writeFileSync(path, `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.event || !args["files-from"]) {
    throw new Error("Usage: node scripts/ci-impact-plan.mjs --event <event> --files-from <path> [--base-sha <sha>] [--head-sha <sha>] [--head-tree-sha <sha>] [--output <path>] [--report <path>]");
  }
  const files = readFileSync(args["files-from"], "utf8").split(/\r?\n/);
  const plan = createImpactPlan({
    event: args.event,
    files,
    baseSha: args["base-sha"],
    headSha: args["head-sha"],
    headTreeSha: args["head-tree-sha"],
  });
  if (args.output) writeGithubOutputs(args.output, plan);
  if (args.report) writeFileSync(args.report, `${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DOC_SECTIONS = {
  English: ["New", "Improved", "Fixed", "Upgrade notes", "Status"],
  Chinese: ["新功能", "改进", "问题修复", "升级说明", "版本状态"],
};
const GITHUB_RELEASE_SECTIONS = ["New", "Improved", "Fixed", "Status"];
const FORBIDDEN_INTERNAL_PATTERNS = [
  { label: "canonical repository", pattern: /\bcanonical repository\b/iu },
  { label: "CI / continuous integration", pattern: /\b(?:ci|continuous integration)\b/iu },
  { label: "main history", pattern: /\bmain(?:-| )history\b/iu },
  { label: "production docs", pattern: /\bproduction(?:-| )docs?\b/iu },
  { label: "second account", pattern: /\bsecond(?:-| )account\b/iu },
  { label: "workflow_dispatch", pattern: /\bworkflow_dispatch\b/iu },
  { label: "release confirmation input", pattern: /\bconfirm_(?:stable|docs)\b/iu },
  { label: "GITHUB_TOKEN", pattern: /\bGITHUB_TOKEN\b/iu },
  { label: "release automation", pattern: /\brelease automation\b/iu },
  { label: "source SHA", pattern: /\bsource SHA\b/iu },
  { label: "branch protection", pattern: /\bbranch protection\b/iu },
  {
    label: "deployment pipeline or authorization",
    pattern: /\b(?:deployment|publishing?) (?:pipeline|workflow|authorization|approval)\b/iu,
  },
  { label: "approval gate", pattern: /\bapproval gate\b/iu },
  {
    label: "development environment or dev shell",
    pattern: /\b(?:development environment|development startup|dev(?:elopment)? shell)\b/iu,
  },
  {
    label: "内部发布流程",
    pattern: /持续集成|发布流水线|(?:生产)?部署流程|生产部署|审批(?:门禁|流程)/u,
  },
  { label: "开发环境", pattern: /开发环境/u },
];
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function releaseEntry(markdown, version) {
  const heading = new RegExp(`^## v${escapeRegExp(version)}\\s*$`, "mu");
  const match = heading.exec(markdown);
  if (!match || match.index === undefined) {
    return null;
  }

  const afterHeading = match.index + match[0].length;
  const nextHeading = /^##\s+/mu;
  nextHeading.lastIndex = afterHeading;
  const nextMatch = nextHeading.exec(markdown.slice(afterHeading));
  const end = nextMatch ? afterHeading + nextMatch.index : markdown.length;
  return markdown.slice(afterHeading, end);
}

function validateEntry(entry, version, locale) {
  const errors = [];
  if (!entry) {
    return [`${locale} changelog is missing the exact heading ## v${version}.`];
  }

  const releaseLink = `[GitHub Release](https://github.com/Undertone0809/rudder/releases/tag/v${version})`;
  if (!entry.includes(releaseLink)) {
    errors.push(`${locale} changelog is missing the GitHub Release link for v${version}.`);
  }

  const sections = PUBLIC_DOC_SECTIONS[locale];
  const headings = [...entry.matchAll(/^###\s+(.+?)\s*$/gmu)];
  const unknownHeadings = headings
    .map((match) => match[1])
    .filter((heading) => !sections.includes(heading));
  if (unknownHeadings.length > 0) {
    errors.push(
      `${locale} changelog has unsupported sections: ${unknownHeadings.join(", ")}.`,
    );
  }

  const presentSections = sections.filter((section) =>
    headings.some((match) => match[1] === section),
  );
  if (presentSections.length === 0) {
    errors.push(
      `${locale} changelog must include at least one user-facing change section.`,
    );
  }

  const presentIndexes = presentSections.map((section) =>
    entry.indexOf(`### ${section}`),
  );
  if (
    presentIndexes.some(
      (index, position) => position > 0 && index < presentIndexes[position - 1],
    )
  ) {
    errors.push(`${locale} changelog sections are out of order.`);
  }

  const firstHeadingIndex = headings[0]?.index ?? entry.length;
  const beforeSections = entry
    .slice(0, firstHeadingIndex)
    .replace(/^Released:\s+.+$/gmu, "")
    .replace(/^发布时间：\s*.+$/gmu, "")
    .replace(/^\[GitHub Release\]\(.+\)$/gmu, "")
    .trim();
  if (!beforeSections) {
    errors.push(`${locale} changelog must include a user-facing summary.`);
  }

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!sections.includes(heading[1])) continue;
    const bodyStart = heading.index + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? entry.length;
    const body = entry.slice(bodyStart, bodyEnd);
    if (!/^\s*-\s+\S+/mu.test(body)) {
      errors.push(`${locale} changelog section ${heading[1]} must not be empty.`);
    }
  }

  for (const { label, pattern } of FORBIDDEN_INTERNAL_PATTERNS) {
    if (pattern.test(entry)) {
      errors.push(
        `${locale} changelog contains internal release terminology: ${label}.`,
      );
    }
  }

  return errors;
}

function validateReleaseNotes(releaseNotes) {
  const errors = [];
  const headings = [...releaseNotes.matchAll(/^##\s+(.+?)\s*$/gmu)];
  const allowedSections = GITHUB_RELEASE_SECTIONS;
  const unknownHeadings = headings
    .map((match) => match[1])
    .filter((heading) => !allowedSections.includes(heading));
  if (unknownHeadings.length > 0) {
    errors.push(
      `GitHub release notes have unsupported sections: ${unknownHeadings.join(", ")}.`,
    );
  }

  const firstHeadingIndex = headings[0]?.index ?? releaseNotes.length;
  if (!releaseNotes.slice(0, firstHeadingIndex).trim()) {
    errors.push("GitHub release notes must include a user-facing summary.");
  }

  if (headings.length === 0) {
    errors.push("GitHub release notes must include at least one user-facing change section.");
  }

  const presentIndexes = allowedSections
    .filter((section) => headings.some((match) => match[1] === section))
    .map((section) => releaseNotes.indexOf(`## ${section}`));
  if (
    presentIndexes.some(
      (index, position) => position > 0 && index < presentIndexes[position - 1],
    )
  ) {
    errors.push("GitHub release notes sections are out of order.");
  }

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!allowedSections.includes(heading[1])) continue;
    const bodyStart = heading.index + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? releaseNotes.length;
    if (!/^\s*-\s+\S+/mu.test(releaseNotes.slice(bodyStart, bodyEnd))) {
      errors.push(`GitHub release notes section ${heading[1]} must not be empty.`);
    }
  }

  for (const { label, pattern } of FORBIDDEN_INTERNAL_PATTERNS) {
    if (pattern.test(releaseNotes)) {
      errors.push(
        `GitHub release notes contain internal release terminology: ${label}.`,
      );
    }
  }

  return errors;
}

export function validateStableChangelog({ english, version, chinese, releaseNotes }) {
  if (!VERSION_PATTERN.test(version)) {
    return [`Version must be a stable semver such as 0.5.1, received ${version || "<empty>"}.`];
  }

  return [
    ...(releaseNotes === undefined ? [] : validateReleaseNotes(releaseNotes)),
    ...validateEntry(releaseEntry(english, version), version, "English"),
    ...validateEntry(releaseEntry(chinese, version), version, "Chinese"),
  ];
}

export function assertStableChangelog(changelog) {
  const errors = validateStableChangelog(changelog);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function parseArgs(args) {
  const options = {
    repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    version: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--version") {
      options.version = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (value === "--repo-root") {
      options.repoRoot = path.resolve(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  return options;
}

function main() {
  const { repoRoot, version } = parseArgs(process.argv.slice(2));
  const english = readFileSync(path.join(repoRoot, "docs", "releases.mdx"), "utf8");
  const chinese = readFileSync(path.join(repoRoot, "docs", "zh", "releases.mdx"), "utf8");
  const releaseNotes = readFileSync(
    path.join(repoRoot, "releases", `v${version}.md`),
    "utf8",
  );
  assertStableChangelog({ english, version, chinese, releaseNotes });
  console.error(`Verified GitHub, English, and Chinese public changelog entries for v${version}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

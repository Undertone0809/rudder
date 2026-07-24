import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHANGELOG_SECTIONS = ["New Features", "Improvements", "Bug Fixes"];
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

  const sectionIndexes = CHANGELOG_SECTIONS.map((section) =>
    entry.indexOf(`### ${section}`),
  );
  if (sectionIndexes.some((index) => index === -1)) {
    errors.push(
      `${locale} changelog must include ### New Features, ### Improvements, and ### Bug Fixes.`,
    );
  } else if (sectionIndexes.some((index, position) => position > 0 && index < sectionIndexes[position - 1])) {
    errors.push(
      `${locale} changelog must order New Features, Improvements, then Bug Fixes.`,
    );
  }

  return errors;
}

export function validateStableChangelog({ english, version, chinese }) {
  if (!VERSION_PATTERN.test(version)) {
    return [`Version must be a stable semver such as 0.5.1, received ${version || "<empty>"}.`];
  }

  return [
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
  assertStableChangelog({ english, version, chinese });
  console.error(`Verified English and Chinese public changelog entries for v${version}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

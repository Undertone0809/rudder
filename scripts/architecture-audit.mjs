#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_LINES = 1500;
const DATA_BOUNDARY_MARKERS = /\b(limit|cursor|offset|pagination|pageInfo|bounded|take)\b/i;
const LIST_LIKE_FUNCTION_MARKERS =
  /\b(?:async\s+)?function\s+(?:list|search|findMany|query)[A-Z0-9_\w]*\b|\b(?:const|let|var)\s+(?:list|search|findMany|query)[A-Z0-9_\w]*\s*=/i;
const LIST_LIKE_ROUTE_MARKERS =
  /router\.(?:get|post)\s*\([^)]*["'`][^"'`]*(?:list|search|threads|messages|issues|runs|entries|conversations|activity)[^"'`]*["'`]/i;

function parseArgs(argv) {
  const options = {
    baseline: null,
    failOnRegression: false,
    json: false,
    maxLines: DEFAULT_MAX_LINES,
    root: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--fail-on-regression") {
      options.failOnRegression = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--root") {
      options.root = path.resolve(readValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--baseline") {
      options.baseline = path.resolve(readValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--max-lines") {
      const value = Number(readValue(argv, index, arg));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max-lines must be a positive integer");
      }
      options.maxLines = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/architecture-audit.mjs [options]

Options:
  --root <path>        Repository root to scan. Defaults to cwd.
  --max-lines <count>  Oversized file threshold. Defaults to ${DEFAULT_MAX_LINES}.
  --baseline <path>    JSON baseline with oversizedFiles [{ path, lines }].
  --fail-on-regression Exit 1 when oversized files are new or grow past baseline.
  --json               Print machine-readable JSON.
  -h, --help           Show this help.
`);
}

function auditArchitecture(options) {
  const root = path.resolve(options.root);
  const files = walkProductionSourceFiles(root);

  const oversizedFiles = [];
  const advisoryListLikeFiles = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    const relativePath = toPosix(path.relative(root, filePath));
    const lines = countLines(content);

    if (lines > options.maxLines) {
      oversizedFiles.push({ path: relativePath, lines });
    }

    if (isServerDataPath(relativePath) && looksListLike(relativePath, content) && !DATA_BOUNDARY_MARKERS.test(content)) {
      advisoryListLikeFiles.push({
        path: relativePath,
        reason: "list-like server path without visible limit/cursor/offset/pagination/bounded/take marker",
      });
    }
  }

  oversizedFiles.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  advisoryListLikeFiles.sort((left, right) => left.path.localeCompare(right.path));
  const baseline = options.baseline ? readBaseline(options.baseline) : null;
  const regressions = baseline ? findRegressions(oversizedFiles, baseline) : [];

  return {
    advisoryListLikeFiles,
    baselinePath: options.baseline,
    maxLines: options.maxLines,
    oversizedFiles,
    regressions,
    root,
    scannedFiles: files.length,
  };
}

function readBaseline(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const entries = Array.isArray(parsed?.oversizedFiles) ? parsed.oversizedFiles : [];
  const oversizedFileLines = new Map();

  for (const entry of entries) {
    if (typeof entry?.path !== "string") continue;
    if (!Number.isInteger(entry.lines) || entry.lines < 1) continue;
    oversizedFileLines.set(entry.path, entry.lines);
  }

  return { oversizedFileLines };
}

function findRegressions(oversizedFiles, baseline) {
  const regressions = [];

  for (const entry of oversizedFiles) {
    const baselineLines = baseline.oversizedFileLines.get(entry.path) ?? null;
    if (baselineLines === null) {
      regressions.push({
        path: entry.path,
        lines: entry.lines,
        baselineLines,
        reason: "new oversized file",
      });
      continue;
    }
    if (entry.lines > baselineLines) {
      regressions.push({
        path: entry.path,
        lines: entry.lines,
        baselineLines,
        reason: "oversized file grew past baseline",
      });
    }
  }

  return regressions;
}

function walkProductionSourceFiles(root) {
  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => right.name.localeCompare(left.name));

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(root, fullPath));

      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(relativePath)) {
          stack.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && isProductionSourceFile(relativePath)) {
        files.push(fullPath);
      }
    }
  }

  return files.sort((left, right) => toPosix(left).localeCompare(toPosix(right)));
}

function shouldSkipDirectory(relativePath) {
  if (!relativePath) {
    return false;
  }

  const segments = relativePath.split("/");
  const skippedSegment = segments.some((segment) =>
    [
      ".git",
      ".next",
      ".turbo",
      "__generated__",
      "build",
      "coverage",
      "dist",
      "generated",
      "node_modules",
    ].includes(segment),
  );

  return skippedSegment || relativePath === "desktop/.packaged" || relativePath.startsWith("desktop/.packaged/");
}

function isProductionSourceFile(relativePath) {
  if (!/\.(ts|tsx)$/.test(relativePath) || /\.d\.ts$/.test(relativePath)) {
    return false;
  }

  if (!isProductionSourceRoot(relativePath)) {
    return false;
  }

  const basename = path.posix.basename(relativePath);
  if (/\.(test|spec)\.(ts|tsx)$/.test(basename)) {
    return false;
  }

  const segments = relativePath.split("/");
  if (segments.includes("__tests__")) {
    return false;
  }

  return !relativePath.startsWith("packages/plugins/examples/");
}

function isProductionSourceRoot(relativePath) {
  return (
    relativePath.startsWith("server/src/") ||
    relativePath.startsWith("ui/src/") ||
    relativePath.startsWith("desktop/src/") ||
    relativePath.startsWith("cli/src/") ||
    /^packages\/[^/]+\/src\//.test(relativePath)
  );
}

function isServerDataPath(relativePath) {
  return relativePath.startsWith("server/src/routes/") || relativePath.startsWith("server/src/services/");
}

function looksListLike(relativePath, content) {
  return LIST_LIKE_FUNCTION_MARKERS.test(content) || LIST_LIKE_ROUTE_MARKERS.test(content);
}

function countLines(content) {
  if (content.length === 0) {
    return 0;
  }
  const trailingNewline = content.endsWith("\n") ? 1 : 0;
  return content.split(/\r\n|\r|\n/).length - trailingNewline;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function printTextReport(result) {
  console.log("Architecture audit (warning-only)");
  console.log(`Root: ${result.root}`);
  console.log(`Scanned production source files: ${result.scannedFiles}`);
  console.log(`Oversized threshold: ${result.maxLines} lines`);
  console.log("");

  if (result.oversizedFiles.length === 0) {
    console.log("Oversized production files: none");
  } else {
    console.log("Oversized production files:");
    for (const entry of result.oversizedFiles) {
      console.log(`- ${entry.lines.toString().padStart(5, " ")}  ${entry.path}`);
    }
  }

  console.log("");
  if (result.advisoryListLikeFiles.length === 0) {
    console.log("Advisory list-like data paths: none");
  } else {
    console.log("Advisory list-like data paths:");
    for (const entry of result.advisoryListLikeFiles) {
      console.log(`- ${entry.path} (${entry.reason})`);
    }
  }

  console.log("");
  if (result.baselinePath) {
    if (result.regressions.length === 0) {
      console.log("Baseline regressions: none");
    } else {
      console.log("Baseline regressions:");
      for (const entry of result.regressions) {
        const baseline = entry.baselineLines === null ? "none" : `${entry.baselineLines} lines`;
        console.log(`- ${entry.path}: ${entry.lines} lines, baseline ${baseline} (${entry.reason})`);
      }
    }
    console.log("");
  }

  if (result.regressions.length > 0) {
    console.log("Exit status: 1 with --fail-on-regression, otherwise 0 (advisory only)");
  } else {
    console.log("Exit status: 0 (advisory only)");
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const result = auditArchitecture(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextReport(result);
  }
  if (options.failOnRegression && result.regressions.length > 0) {
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

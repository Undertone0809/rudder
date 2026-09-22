import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDesktopReleaseNotes } from "./verify-stable-changelog.mjs";

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
  const english = readFileSync(path.join(repoRoot, "releases", `v${version}.md`), "utf8");
  let chinese = "";
  try {
    chinese = readFileSync(path.join(repoRoot, "releases", "zh", `v${version}.md`), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const errors = validateDesktopReleaseNotes({ english, chinese, version });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  console.error(`Verified English and Chinese Desktop release notes for v${version}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

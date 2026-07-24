import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateStableChangelog } from "./verify-stable-changelog.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const english = readFileSync(path.join(repoRoot, "docs", "releases.mdx"), "utf8");
const chinese = readFileSync(path.join(repoRoot, "docs", "zh", "releases.mdx"), "utf8");

describe("stable public changelog validation", () => {
  it("accepts the checked-in English and Chinese v0.5.1 changelog entries", () => {
    expect(validateStableChangelog({ english, version: "0.5.1", chinese })).toEqual([]);
  });

  it("keeps command-mode stdout empty for release preflight version capture", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-stable-changelog.mjs", "--version", "0.5.1"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Verified English and Chinese public changelog entries for v0.5.1.",
    );
  });

  it("requires both localized version entries", () => {
    expect(
      validateStableChangelog({
        english,
        version: "0.5.1",
        chinese: chinese.replace(/^## v0\.5\.1$/mu, "## v0.5.0"),
      }),
    ).toEqual(
      expect.arrayContaining(["Chinese changelog is missing the exact heading ## v0.5.1."]),
    );
  });

  it("requires the stable changelog taxonomy in each public entry", () => {
    expect(
      validateStableChangelog({
        english: english.replace("### Bug Fixes", "### Highlights"),
        version: "0.5.1",
        chinese,
      }),
    ).toEqual(
      expect.arrayContaining([
        "English changelog must include ### New Features, ### Improvements, and ### Bug Fixes.",
      ]),
    );
  });
});

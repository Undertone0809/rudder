import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateStableChangelog } from "./verify-stable-changelog.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const english = readFileSync(path.join(repoRoot, "docs", "releases.mdx"), "utf8");
const chinese = readFileSync(path.join(repoRoot, "docs", "zh", "releases.mdx"), "utf8");
const releaseNotes = readFileSync(path.join(repoRoot, "releases", "v0.6.1.md"), "utf8");

function changelogUpdates(markdown) {
  return [...markdown.matchAll(/^<Update\b([^>]*)>\s*\n([\s\S]*?)\n<\/Update>$/gmu)].map(
    (match) => ({ props: match[1], body: match[2] }),
  );
}

function expectTimelineEntries(markdown, categories) {
  const versions = [...markdown.matchAll(/^## v(\d+\.\d+\.\d+)$/gmu)].map(
    (match) => match[1],
  );
  const updates = changelogUpdates(markdown);

  expect(updates).toHaveLength(versions.length);
  expect(markdown.match(/^<Update\b/gmu) ?? []).toHaveLength(versions.length);
  expect(markdown.match(/^<\/Update>$/gmu) ?? []).toHaveLength(versions.length);

  for (const [index, version] of versions.entries()) {
    const update = updates[index];
    expect(update.props).toMatch(/\blabel="[^"]+"/u);
    expect(update.props).toContain(`description="v${version}"`);
    expect(update.body).toMatch(new RegExp(`^## v${version.replaceAll(".", "\\.")}\\s*$`, "mu"));
    expect(update.body).not.toMatch(/^Released:|^发布时间：/mu);

    const expectedTags = categories.filter((category) =>
      update.body.includes(`### ${category}`),
    );
    expect(update.props).toContain(`tags={${JSON.stringify(expectedTags)}}`);
  }
}

describe("stable public changelog validation", () => {
  it("accepts the checked-in English and Chinese v0.6.1 changelog entries", () => {
    expect(
      validateStableChangelog({ english, version: "0.6.1", chinese, releaseNotes }),
    ).toEqual([]);
  });

  it("keeps command-mode stdout empty for release preflight version capture", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-stable-changelog.mjs", "--version", "0.6.1"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Verified GitHub, English, and Chinese public changelog entries for v0.6.1.",
    );
  });

  it("requires both localized version entries", () => {
    expect(
      validateStableChangelog({
        english,
        version: "0.6.1",
        chinese: chinese.replace(/^## v0\.6\.1$/mu, "## v0.5.0"),
        releaseNotes,
      }),
    ).toEqual(
      expect.arrayContaining(["Chinese changelog is missing the exact heading ## v0.6.1."]),
    );
  });

  it("allows locale-specific sections and omits categories with no user-facing changes", () => {
    const minimalEnglish = [
      "## v9.9.9",
      "",
      "[GitHub Release](https://github.com/Undertone0809/rudder/releases/tag/v9.9.9)",
      "",
      "This patch fixes installation.",
      "",
      "### Fixed",
      "",
      "- Fixed installation.",
    ].join("\n");
    const minimalChinese = [
      "## v9.9.9",
      "",
      "[GitHub Release](https://github.com/Undertone0809/rudder/releases/tag/v9.9.9)",
      "",
      "这个补丁修复安装问题。",
      "",
      "### 问题修复",
      "",
      "- 修复安装问题。",
    ].join("\n");

    expect(
      validateStableChangelog({
        english: minimalEnglish,
        version: "9.9.9",
        chinese: minimalChinese,
      }),
    ).toEqual([]);
  });

  it("rejects unsupported or empty sections", () => {
    expect(
      validateStableChangelog({
        english: english.replace(
          /(## v0\.6\.1[\s\S]*?)### Fixed/u,
          "$1### Internal changes",
        ),
        version: "0.6.1",
        chinese,
        releaseNotes,
      }),
    ).toEqual(
      expect.arrayContaining([
        "English changelog has unsupported sections: Internal changes.",
      ]),
    );
  });

  it("rejects internal release terminology from public notes", () => {
    expect(
      validateStableChangelog({
        english: english.replace(
          "This patch makes first-time installation on macOS reliable again.",
          "Added exact-source CI validation.",
        ),
        version: "0.6.1",
        chinese,
        releaseNotes,
      }),
    ).toEqual(
      expect.arrayContaining([
        "English changelog contains internal release terminology: CI / continuous integration.",
      ]),
    );
  });

  it("rejects English and Chinese variants of internal release operations", () => {
    expect(
      validateStableChangelog({
        english: english.replace(
          "This patch makes first-time installation on macOS reliable again.",
          "Improved the CI workflow, deployment pipeline, and approval gate.",
        ),
        version: "0.6.1",
        chinese: chinese.replace(
          "这个补丁恢复了 macOS 首次安装的可靠性。",
          "改进持续集成工作流、生产部署和审批流程。",
        ),
        releaseNotes,
      }),
    ).toEqual(
      expect.arrayContaining([
        "English changelog contains internal release terminology: CI / continuous integration.",
        "English changelog contains internal release terminology: deployment pipeline or authorization.",
        "English changelog contains internal release terminology: approval gate.",
        "Chinese changelog contains internal release terminology: 内部发布流程.",
      ]),
    );
  });

  it("rejects internal operations and upgrade-only sections in GitHub release notes", () => {
    const internalNotes = [
      "Improved the release process.",
      "",
      "## Improved",
      "",
      "- Improved the deployment pipeline.",
    ].join("\n");
    const upgradeOnlyNotes = [
      "Review this before upgrading.",
      "",
      "## Upgrade notes",
      "",
      "- Back up your data.",
    ].join("\n");

    expect(
      validateStableChangelog({
        english,
        version: "0.6.1",
        chinese,
        releaseNotes: internalNotes,
      }),
    ).toEqual(
      expect.arrayContaining([
        "GitHub release notes contain internal release terminology: deployment pipeline or authorization.",
      ]),
    );
    expect(
      validateStableChangelog({
        english,
        version: "0.6.1",
        chinese,
        releaseNotes: upgradeOnlyNotes,
      }),
    ).toEqual(
      expect.arrayContaining([
        "GitHub release notes have unsupported sections: Upgrade notes.",
      ]),
    );
  });

  it("rejects contributor development-environment fixes in every public locale", () => {
    const internalReleaseNotes = [
      "This patch improves Desktop.",
      "",
      "## Fixed",
      "",
      "- Fixed the Desktop dev shell regression.",
    ].join("\n");

    expect(
      validateStableChangelog({
        english: english.replace(
          "This release adds inline Chat editing and makes Messenger, mentions, Markdown, and Desktop navigation more polished.",
          "Fixed the Desktop dev shell regression in the development environment.",
        ),
        version: "0.3.2",
        chinese: chinese.replace(
          "这个版本增加 Chat 消息编辑，并改善 Messenger、提及、Markdown 和 Desktop 导航。",
          "修复 Desktop 开发环境启动问题。",
        ),
        releaseNotes: internalReleaseNotes,
      }),
    ).toEqual(
      expect.arrayContaining([
        "English changelog contains internal release terminology: development environment or dev shell.",
        "Chinese changelog contains internal release terminology: 开发环境.",
        "GitHub release notes contain internal release terminology: development environment or dev shell.",
      ]),
    );
  });

  it("keeps every historical public entry user-facing and localized", () => {
    const englishVersions = [...english.matchAll(/^## v(\d+\.\d+\.\d+)$/gmu)].map(
      (match) => match[1],
    );
    const chineseVersions = [...chinese.matchAll(/^## v(\d+\.\d+\.\d+)$/gmu)].map(
      (match) => match[1],
    );

    expect(chineseVersions).toEqual(englishVersions);
    for (const version of englishVersions) {
      const historicalNotes = readFileSync(
        path.join(repoRoot, "releases", `v${version}.md`),
        "utf8",
      );
      expect(
        validateStableChangelog({
          english,
          version,
          chinese,
          releaseNotes: historicalNotes,
        }),
      ).toEqual([]);
    }
  });

  it("keeps every localized release inside the Mintlify changelog timeline", () => {
    expectTimelineEntries(english, ["New", "Improved", "Fixed", "Upgrade notes"]);
    expectTimelineEntries(chinese, ["新功能", "改进", "问题修复", "升级说明"]);
  });
});

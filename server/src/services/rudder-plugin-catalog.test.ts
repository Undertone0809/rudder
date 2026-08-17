import { describe, expect, it } from "vitest";
import {
  catalogSourceMatches,
  createCatalogFreshnessLease,
  discoverSkillsAddPaths,
  fetchPluginCatalogResource,
  parseSkillsAddSource,
  resolveGitHubVersion,
  synthesizeSkillsPlugin,
} from "./rudder-plugin-catalog.js";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseSkillsAddSource", () => {
  it("accepts owner/repository, HTTPS, tree, ref, and explicit subdirectory inputs", () => {
    expect(parseSkillsAddSource("coreyhaines31/marketingskills")).toEqual({
      repositoryUrl: "https://github.com/coreyhaines31/marketingskills",
      source: "coreyhaines31/marketingskills",
      owner: "coreyhaines31",
      repo: "marketingskills",
      ref: null,
      subdirectory: "",
    });
    expect(parseSkillsAddSource("obra/superpowers@v6.3.0/skills", "skills/brainstorming")).toMatchObject({
      owner: "obra",
      repo: "superpowers",
      ref: "v6.3.0",
      subdirectory: "skills/brainstorming",
    });
    expect(parseSkillsAddSource("https://github.com/openai/plugins/tree/main/plugins/remotion")).toMatchObject({
      owner: "openai",
      repo: "plugins",
      ref: "main",
      subdirectory: "plugins/remotion",
    });
  });

  it("rejects SSH, local, non-GitHub, and traversal sources", () => {
    expect(() => parseSkillsAddSource("git@github.com:owner/repo.git")).toThrow(/public GitHub/);
    expect(() => parseSkillsAddSource("../local-skills")).toThrow(/public GitHub/);
    expect(() => parseSkillsAddSource("https://gitlab.com/owner/repo")).toThrow(/github.com/);
    expect(() => parseSkillsAddSource("owner/repo", "skills/../private")).toThrow(/unsafe path/);
  });
});

describe("catalogSourceMatches", () => {
  it("matches normalized repository and subdirectory identities", () => {
    expect(catalogSourceMatches(
      { repositoryUrl: "https://github.com/obra/superpowers.git", subdirectory: "./" },
      { repositoryUrl: "https://github.com/OBRA/superpowers/", subdirectory: "" },
    )).toBe(true);
    expect(catalogSourceMatches(
      { repositoryUrl: "https://github.com/openai/plugins", subdirectory: "plugins/canva/" },
      { repositoryUrl: "https://github.com/openai/plugins", subdirectory: "plugins/canva" },
    )).toBe(true);
  });

  it("does not conflate repositories or Plugin subdirectories", () => {
    expect(catalogSourceMatches(
      { repositoryUrl: "https://github.com/openai/plugins", subdirectory: "plugins/canva" },
      { repositoryUrl: "https://github.com/openai/plugins", subdirectory: "plugins/vercel" },
    )).toBe(false);
    expect(catalogSourceMatches(
      { repositoryUrl: "https://github.com/obra/superpowers", subdirectory: "" },
      { repositoryUrl: "https://github.com/coreyhaines31/marketingskills", subdirectory: "" },
    )).toBe(false);
  });
});

describe("fetchPluginCatalogResource", () => {
  it("permits same-host HTTPS redirects and rejects cross-host redirects", async () => {
    const allowed = new Set(["catalog.example"]);
    const sameHost = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/catalog.json") {
        return new Response(null, { status: 302, headers: { location: "/v1/catalog.json" } });
      }
      return json({ schemaVersion: 1 });
    };
    await expect(fetchPluginCatalogResource(
      sameHost as typeof fetch,
      "https://catalog.example/catalog.json",
      {},
      allowed,
    )).resolves.toMatchObject({ status: 200 });

    const crossHost = async () => new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/catalog.json" },
    });
    await expect(fetchPluginCatalogResource(
      crossHost as typeof fetch,
      "https://catalog.example/catalog.json",
      {},
      allowed,
    )).rejects.toThrow(/outside the allowed HTTPS hosts/);
  });
});

describe("resolveGitHubVersion", () => {
  it("falls back to public GitHub pages when the REST API is rate limited", async () => {
    const commitSha = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";
    const requested: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith("https://api.github.com/")) {
        return new Response("rate limited", { status: 403 });
      }
      if (url === "https://github.com/obra/superpowers/releases.atom") {
        return new Response(`<?xml version="1.0"?>
          <feed xmlns="http://www.w3.org/2005/Atom">
            <entry><link rel="alternate" href="https://github.com/obra/superpowers/releases/tag/v6.2.0" /></entry>
            <entry><link rel="alternate" href="https://github.com/obra/superpowers/releases/tag/v6.3.0" /></entry>
          </feed>`);
      }
      if (url === "https://github.com/obra/superpowers/commits/v6.3.0.atom") {
        return new Response(`<feed><entry><id>tag:github.com,2008:Grit::Commit/${commitSha}</id></entry></feed>`);
      }
      return new Response("not found", { status: 404 });
    };

    await expect(resolveGitHubVersion(fetcher as typeof fetch, {
      repositoryUrl: "https://github.com/obra/superpowers",
      source: "obra/superpowers",
      subdirectory: "",
    })).resolves.toEqual({
      repositoryUrl: "https://github.com/obra/superpowers",
      source: "obra/superpowers",
      subdirectory: "",
      strategy: "stable_release",
      version: "6.3.0",
      commitSha,
    });
    expect(requested).toContain("https://github.com/obra/superpowers/releases.atom");
    expect(requested).toContain("https://github.com/obra/superpowers/commits/v6.3.0.atom");
  });

  it("fails closed instead of selecting HEAD when the public release feed is unavailable", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        return new Response("rate limited", { status: 403 });
      }
      if (url === "https://github.com/obra/superpowers/releases.atom") {
        return new Response("authentication required", { status: 401 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await expect(resolveGitHubVersion(fetcher as typeof fetch, {
      repositoryUrl: "https://github.com/obra/superpowers",
      source: "obra/superpowers",
      subdirectory: "",
    })).rejects.toThrow("GitHub release feed returned HTTP 401");
  });
});

describe("createCatalogFreshnessLease", () => {
  it("keeps a degraded catalog visible through immediate recovery", () => {
    let now = 1_000;
    const lease = createCatalogFreshnessLease(30_000, () => now);

    expect(lease.observe("fresh")).toBe("fresh");
    expect(lease.observe("stale")).toBe("stale");

    now += 29_999;
    expect(lease.observe("fresh")).toBe("stale");

    now += 1;
    expect(lease.observe("fresh")).toBe("fresh");
  });

  it("extends the visibility window when degradation is observed again", () => {
    let now = 1_000;
    const lease = createCatalogFreshnessLease(30_000, () => now);

    expect(lease.observe("stale")).toBe("stale");
    now += 20_000;
    expect(lease.observe("stale")).toBe("stale");
    now += 20_000;
    expect(lease.observe("fresh")).toBe("stale");
    now += 10_000;
    expect(lease.observe("fresh")).toBe("fresh");
  });
});

describe("discoverSkillsAddPaths", () => {
  const blob = (path: string) => ({ path, type: "blob" as const, sha: "a".repeat(40), size: 40 });

  it("discovers a root Skill and stops at that direct entrypoint", () => {
    expect(discoverSkillsAddPaths([
      blob("SKILL.md"),
      blob("examples/nested/SKILL.md"),
    ])).toEqual(["SKILL.md"]);
  });

  it("matches skills CLI priority containers and does not descend past a Skill root", () => {
    expect(discoverSkillsAddPaths([
      blob("skills/cro/SKILL.md"),
      blob("skills/cro/internal/SKILL.md"),
      blob("skills/seo/technical/SKILL.md"),
      blob(".agents/skills/research/SKILL.md"),
      blob("examples/unrelated/SKILL.md"),
      blob("node_modules/unsafe/SKILL.md"),
    ])).toEqual([
      ".agents/skills/research/SKILL.md",
      "skills/cro/SKILL.md",
      "skills/seo/technical/SKILL.md",
    ]);
  });

  it("honors a safe source subdirectory and fallback depth", () => {
    expect(discoverSkillsAddPaths([
      blob("plugins/demo/examples/deep/SKILL.md"),
      blob("plugins/other/skills/ignored/SKILL.md"),
    ], "plugins/demo")).toEqual(["plugins/demo/examples/deep/SKILL.md"]);
  });

  it("does not fall back into ignored directories", () => {
    expect(discoverSkillsAddPaths([
      blob("node_modules/unsafe/SKILL.md"),
      blob("DIST/generated/SKILL.md"),
      blob("build/generated/SKILL.md"),
      blob("examples/valid/SKILL.md"),
    ])).toEqual(["examples/valid/SKILL.md"]);
  });

  it("handles a production-shaped 49-Skill bundle deterministically", () => {
    const tree = Array.from({ length: 49 }, (_, index) => blob(`skills/skill-${String(index).padStart(2, "0")}/SKILL.md`));
    const result = discoverSkillsAddPaths(tree);
    expect(result).toHaveLength(49);
    expect(result[0]).toBe("skills/skill-00/SKILL.md");
    expect(result.at(-1)).toBe("skills/skill-48/SKILL.md");
  });
});

describe("synthesizeSkillsPlugin", () => {
  it("preserves root Skill supporting files in the generated package", () => {
    const descriptor = {
      schemaVersion: 1,
      slug: "root-skill",
      kind: "skills_add",
      displayName: "Root Skill",
      developer: "Example",
      category: "Developer Tools",
      shortDescription: "A root Skill.",
      longDescription: "A root Skill with supporting files.",
      capabilities: ["Read"],
      websiteUrl: "https://github.com/example/root-skill",
      privacyPolicyUrl: "https://example.com/privacy",
      termsOfServiceUrl: "https://example.com/terms",
      license: { spdx: "MIT", sourceUrl: "https://example.com/license", note: "Fixture" },
      source: {
        repositoryUrl: "https://github.com/example/root-skill",
        skillsAddSource: "example/root-skill",
        subdirectory: "",
        versionStrategy: "latest_stable_release_or_head",
      },
      assets: { icon: "assets/icon.png", iconDark: "assets/icon-dark.png", origin: "rudder_generic" },
    } as Parameters<typeof synthesizeSkillsPlugin>[0];
    const resolution = {
      repositoryUrl: "https://github.com/example/root-skill",
      source: "example/root-skill",
      subdirectory: "",
      strategy: "default_branch_head",
      version: "abcdef123456",
      commitSha: "a".repeat(40),
    } as Parameters<typeof synthesizeSkillsPlugin>[1];
    const tree = [
      { path: "SKILL.md", type: "blob", sha: "a".repeat(40), size: 40 },
      { path: "references/guide.md", type: "blob", sha: "b".repeat(40), size: 40 },
      { path: "README.md", type: "blob", sha: "c".repeat(40), size: 40 },
      { path: "examples/nested/SKILL.md", type: "blob", sha: "d".repeat(40), size: 40 },
    ] as Parameters<typeof synthesizeSkillsPlugin>[2];
    const files = [
      { path: "SKILL.md", content: "---\nname: Root Skill\ndescription: Root instructions.\n---\n", encoding: "utf8" as const },
      { path: "references/guide.md", content: "Supporting guidance.", encoding: "utf8" as const },
      { path: "README.md", content: "Package context.", encoding: "utf8" as const },
      { path: "examples/nested/SKILL.md", content: "Nested example.", encoding: "utf8" as const },
    ] as Parameters<typeof synthesizeSkillsPlugin>[3];

    const packageFiles = synthesizeSkillsPlugin(descriptor, resolution, tree, files);

    expect(packageFiles.map((file) => file.path)).toEqual([
      ".codex-plugin/plugin.json",
      "skills/root-skill/SKILL.md",
      "skills/root-skill/references/guide.md",
      "skills/root-skill/README.md",
    ]);
  });

  it("does not promote undiscovered nested Skill entries in a priority container", () => {
    const descriptor = {
      schemaVersion: 1,
      slug: "container-skills",
      kind: "skills_add",
      displayName: "Container Skills",
      developer: "Example",
      category: "Developer Tools",
      shortDescription: "Container Skills.",
      longDescription: "Skills discovered from a priority container.",
      capabilities: ["Read"],
      websiteUrl: "https://github.com/example/container-skills",
      privacyPolicyUrl: "https://example.com/privacy",
      termsOfServiceUrl: "https://example.com/terms",
      license: { spdx: "MIT", sourceUrl: "https://example.com/license", note: "Fixture" },
      source: {
        repositoryUrl: "https://github.com/example/container-skills",
        skillsAddSource: "example/container-skills",
        subdirectory: "",
        versionStrategy: "latest_stable_release_or_head",
      },
      assets: { icon: "assets/icon.png", iconDark: "assets/icon-dark.png", origin: "rudder_generic" },
    } as Parameters<typeof synthesizeSkillsPlugin>[0];
    const resolution = {
      repositoryUrl: "https://github.com/example/container-skills",
      source: "example/container-skills",
      subdirectory: "",
      strategy: "default_branch_head",
      version: "abcdef123456",
      commitSha: "a".repeat(40),
    } as Parameters<typeof synthesizeSkillsPlugin>[1];
    const tree = [
      { path: "skills/demo/SKILL.md", type: "blob", sha: "a".repeat(40), size: 40 },
      { path: "skills/demo/internal/SKILL.md", type: "blob", sha: "b".repeat(40), size: 40 },
      { path: "skills/demo/references/guide.md", type: "blob", sha: "c".repeat(40), size: 40 },
    ] as Parameters<typeof synthesizeSkillsPlugin>[2];
    const files = [
      { path: "skills/demo/SKILL.md", content: "---\nname: Demo\ndescription: Demo instructions.\n---\n", encoding: "utf8" as const },
      { path: "skills/demo/internal/SKILL.md", content: "Nested example.", encoding: "utf8" as const },
      { path: "skills/demo/references/guide.md", content: "Supporting guidance.", encoding: "utf8" as const },
    ] as Parameters<typeof synthesizeSkillsPlugin>[3];

    const packageFiles = synthesizeSkillsPlugin(descriptor, resolution, tree, files);

    expect(packageFiles.map((file) => file.path)).toEqual([
      ".codex-plugin/plugin.json",
      "skills/demo/SKILL.md",
      "skills/demo/references/guide.md",
    ]);
  });
});

describe("resolveGitHubVersion", () => {
  it("chooses the highest stable semantic release and freezes its commit SHA", async () => {
    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/repos/owner/repo")) return json({ default_branch: "main", private: false });
      if (url.includes("/releases?")) return json([
        { tag_name: "v2.0.0-beta.1", draft: false, prerelease: true },
        { tag_name: "v1.9.0", draft: false, prerelease: false },
        { tag_name: "v2.0.0", draft: false, prerelease: false },
      ]);
      if (url.endsWith("/commits/v2.0.0")) return json({ sha: "b".repeat(40) });
      return json({}, 404);
    };
    await expect(resolveGitHubVersion(fetcher as typeof fetch, {
      repositoryUrl: "https://github.com/owner/repo",
      source: "owner/repo",
      subdirectory: "skills",
    })).resolves.toEqual({
      repositoryUrl: "https://github.com/owner/repo",
      source: "owner/repo",
      subdirectory: "skills",
      strategy: "stable_release",
      version: "2.0.0",
      commitSha: "b".repeat(40),
    });
    expect(calls.some((url) => url.endsWith("/commits/main"))).toBe(false);
  });

  it("falls back to default branch HEAD and keeps explicit refs explicit", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo")) return json({ default_branch: "trunk", private: false });
      if (url.includes("/releases?")) return json([]);
      if (url.endsWith("/commits/trunk")) return json({ sha: "c".repeat(40) });
      if (url.endsWith("/commits/feature%2Fcatalog")) return json({ sha: "d".repeat(40) });
      return json({}, 404);
    };
    await expect(resolveGitHubVersion(fetcher as typeof fetch, {
      repositoryUrl: "https://github.com/owner/repo",
      source: "owner/repo",
      subdirectory: "",
    })).resolves.toMatchObject({
      strategy: "default_branch_head",
      version: "cccccccccccc",
      commitSha: "c".repeat(40),
    });
    await expect(resolveGitHubVersion(fetcher as typeof fetch, {
      repositoryUrl: "https://github.com/owner/repo",
      source: "owner/repo",
      subdirectory: "",
      ref: "feature/catalog",
    })).resolves.toMatchObject({
      strategy: "explicit_ref",
      version: "feature/catalog",
      commitSha: "d".repeat(40),
    });
  });

  it("rejects private sources and non-full commit identities", async () => {
    await expect(resolveGitHubVersion((async () => json({ private: true, default_branch: "main" })) as typeof fetch, {
      repositoryUrl: "https://github.com/owner/repo",
      source: "owner/repo",
      subdirectory: "",
    })).rejects.toThrow(/must be public/);
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo")) return json({ default_branch: "main", private: false });
      if (url.includes("/releases?")) return json([]);
      return json({ sha: "short" });
    };
    await expect(resolveGitHubVersion(fetcher as typeof fetch, {
      repositoryUrl: "https://github.com/owner/repo",
      source: "owner/repo",
      subdirectory: "",
    })).rejects.toThrow(/full immutable commit SHA/);
  });
});

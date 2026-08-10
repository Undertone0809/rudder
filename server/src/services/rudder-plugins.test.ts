import type { InspectRudderPlugin } from "@rudderhq/shared";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { inspectRudderPluginArchivePackage, inspectRudderPluginPackage } from "./rudder-plugins.js";

function manifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "research-kit",
    version: "1.2.0",
    description: "Research with repeatable evidence.",
    author: { name: "Acme" },
    interface: {
      displayName: "Research Kit",
      shortDescription: "Research with repeatable evidence.",
      developerName: "Acme",
      category: "Productivity",
    },
    ...overrides,
  });
}

function input(
  files: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>,
): InspectRudderPlugin {
  return {
    sourceLabel: "research-kit",
    sourceType: "local_upload",
    files: [
      { path: ".codex-plugin/plugin.json", content: manifest(), encoding: "utf8" },
      ...files.map((file) => ({ ...file, encoding: file.encoding ?? "utf8" as const })),
    ],
  };
}

describe("inspectRudderPluginPackage", () => {
  it("maps Codex Skills, inline MCP servers, App aliases, and hooks without executing content", () => {
    const executionMarker = "__rudder_plugin_import_executed__";
    delete (globalThis as Record<string, unknown>)[executionMarker];
    const candidate = input([
      { path: "skills/research/SKILL.md", content: "---\nname: Research\ndescription: Find evidence.\n---\n" },
      { path: "skills/research/references/guide.md", content: "Guide" },
      { path: ".app.json", content: JSON.stringify({ canvas: "asdk_app_123" }) },
      { path: "hooks/on-install.js", content: `globalThis.${executionMarker} = true` },
    ]);
    candidate.files[0]!.content = manifest({
      mcpServers: {
        search: { type: "http", url: "https://example.com/mcp" },
      },
      apps: "./.app.json",
    });

    const result = inspectRudderPluginPackage(candidate);

    expect(result.report.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "skill:research", status: "ready" }),
      expect.objectContaining({ key: "mcp:search", status: "setup_required", path: ".codex-plugin/plugin.json" }),
      expect.objectContaining({ key: "app:canvas", status: "unsupported" }),
      expect.objectContaining({ key: "unsupported:hooks", status: "unsupported" }),
    ]));
    expect(result.report.warnings).toContain("Hooks are preserved but unsupported and will not run.");
    expect((globalThis as Record<string, unknown>)[executionMarker]).toBeUndefined();
  });

  it("inventories executable Skill files and unsupported Codex browser and scheduled-task surfaces", () => {
    const candidate = input([
      { path: "skills/research/SKILL.md", content: "---\nname: Research\n---\n" },
      { path: "skills/research/scripts/run.py", content: "print('research')\n" },
      { path: "browser-extensions/chrome/manifest.json", content: "{}" },
      { path: "scheduled-tasks/daily.json", content: "{}" },
    ]);
    candidate.files[0]!.content = manifest({
      browserExtensions: "./browser-extensions/",
      taskTemplates: "./scheduled-tasks/",
    });

    const result = inspectRudderPluginPackage(candidate);

    expect(result.report.components).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "skill:research",
        metadata: expect.objectContaining({
          executableFiles: [expect.objectContaining({ path: "skills/research/scripts/run.py" })],
        }),
      }),
      expect.objectContaining({ key: "unsupported:browser-extensions", status: "unsupported" }),
      expect.objectContaining({ key: "unsupported:scheduled-task-templates", status: "unsupported" }),
    ]));
  });

  it("supports custom manifest component paths and supplements default discovery", () => {
    const candidate = input([
      { path: "methods/review/SKILL.md", content: "---\nname: Review\n---\n" },
      { path: "config/servers.json", content: JSON.stringify({ docs: { command: "docs-mcp", args: ["serve"] } }) },
      { path: ".mcp.json", content: JSON.stringify({ search: { url: "https://example.com/mcp" } }) },
      { path: "config/apps.json", content: JSON.stringify({ editor: "connector_123" }) },
    ]);
    candidate.files[0]!.content = manifest({
      skills: "./methods/",
      mcpServers: "./config/servers.json",
      apps: "./config/apps.json",
    });

    const result = inspectRudderPluginPackage(candidate);

    expect(result.report.components.map((component) => component.key)).toEqual([
      "skill:review",
      "mcp:search",
      "mcp:docs",
      "app:editor",
    ]);
  });

  it.each([
    "../outside.txt",
    "skills/../outside.txt",
    "/absolute.txt",
  ])("rejects unsafe package path %s", (unsafePath) => {
    expect(() => inspectRudderPluginPackage(input([
      { path: unsafePath, content: "unsafe" },
    ]))).toThrow("Unsafe Plugin file path");
  });

  it("rejects duplicate paths after case folding", () => {
    expect(() => inspectRudderPluginPackage(input([
      { path: "skills/research/SKILL.md", content: "name: Research" },
      { path: "Skills/Research/skill.md", content: "name: Other" },
    ]))).toThrow("duplicate or case-colliding path");
  });

  it("enforces file count and byte limits before parsing", () => {
    const tooMany = Array.from({ length: 500 }, (_, index) => ({
      path: `assets/${index}.txt`,
      content: "x",
    }));
    expect(() => inspectRudderPluginPackage(input(tooMany))).toThrow("500-file");
    expect(() => inspectRudderPluginPackage(input([
      { path: "skills/research/SKILL.md", content: "x".repeat(2 * 1024 * 1024 + 1) },
    ]))).toThrow("exceeds 2 MiB");
  });

  it("rejects literal MCP credentials while allowing environment references", () => {
    const literal = input([
      { path: ".mcp.json", content: JSON.stringify({ search: { url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } } }) },
    ]);
    expect(inspectRudderPluginPackage(literal).report.errors).toContain(
      "MCP configuration appears to contain literal credential material. Replace it with environment references before import.",
    );

    const referenced = input([
      { path: ".mcp.json", content: JSON.stringify({ search: { url: "https://example.com/mcp", headers: { Authorization: "${SEARCH_TOKEN}" } } }) },
    ]);
    expect(inspectRudderPluginPackage(referenced).report.errors).toEqual([]);
  });

  it("rejects invalid identity and missing manifest references", () => {
    const invalidName = input([{ path: "skills/research/SKILL.md", content: "name: Research" }]);
    invalidName.files[0]!.content = manifest({ name: "Research Kit" });
    expect(() => inspectRudderPluginPackage(invalidName)).toThrow("lower-case hyphen-case");

    const invalidVersion = input([{ path: "skills/research/SKILL.md", content: "name: Research" }]);
    invalidVersion.files[0]!.content = manifest({ version: "1.2" });
    expect(() => inspectRudderPluginPackage(invalidVersion)).toThrow("strict semantic versioning");

    const missingConfig = input([{ path: "skills/research/SKILL.md", content: "name: Research" }]);
    missingConfig.files[0]!.content = manifest({ mcpServers: "./missing.json" });
    expect(() => inspectRudderPluginPackage(missingConfig)).toThrow("references a missing file");
  });

  it("preserves unknown manifest fields and reports unsupported-only packages truthfully", () => {
    const candidate = input([
      { path: ".app.json", content: JSON.stringify({ canvas: "asdk_app_123" }) },
    ]);
    candidate.files[0]!.content = manifest({ futureCapability: { revision: 3 }, apps: "./.app.json" });

    const result = inspectRudderPluginPackage(candidate);

    expect(result.manifest.futureCapability).toEqual({ revision: 3 });
    expect(result.report.errors).toContain("The package cannot be installed until it contains at least one supported or setup-capable component.");
    expect(result.report.warnings).toContain("This package has no currently usable Rudder components.");
  });
});

describe("inspectRudderPluginArchivePackage", () => {
  function archive(files: Record<string, string>) {
    return {
      sourceLabel: "archive.zip",
      filename: "archive.zip",
      content: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])))).toString("base64"),
      encoding: "base64" as const,
    };
  }

  it("strips one outer ZIP root and inspects the immutable package snapshot", () => {
    const result = inspectRudderPluginArchivePackage(archive({
      "research-kit/.codex-plugin/plugin.json": manifest(),
      "research-kit/skills/research/SKILL.md": "---\nname: Research\n---\n",
    }));
    expect(result.identity).toMatchObject({ name: "research-kit", version: "1.2.0" });
    expect(result.report.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "skill:research", status: "ready" }),
    ]));
  });

  it("rejects traversal, malformed archives, and high-ratio expansion before persistence", () => {
    expect(() => inspectRudderPluginArchivePackage(archive({
      ".codex-plugin/plugin.json": manifest(),
      "../outside.txt": "unsafe",
    }))).toThrow(/Unsafe Plugin file path/);
    expect(() => inspectRudderPluginArchivePackage({
      sourceLabel: "broken.zip",
      filename: "broken.zip",
      content: Buffer.from("not a zip").toString("base64"),
      encoding: "base64",
    })).toThrow(/Invalid ZIP Plugin archive/);
    expect(() => inspectRudderPluginArchivePackage(archive({
      ".codex-plugin/plugin.json": manifest(),
      "assets/compression-bomb.txt": "0".repeat(512 * 1024),
    }))).toThrow(/expansion limit/);
  });
});

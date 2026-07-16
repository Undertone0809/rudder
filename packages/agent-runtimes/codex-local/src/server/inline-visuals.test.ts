import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_INLINE_VISUAL_MAX_BYTES,
  captureCodexInlineVisuals,
  codexInlineVisualDirectiveBody,
  codexVisualizationThreadDirectory,
} from "./inline-visuals.js";

describe("Codex inline visual capture", () => {
  const cleanup: string[] = [];
  const threadId = "019f6400-1111-7222-8333-444444444444";
  const runAt = new Date(2026, 6, 15, 9, 30, 0);

  async function fixture() {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "rudder-inline-vis-"));
    cleanup.push(codexHome);
    const threadDirectory = codexVisualizationThreadDirectory(codexHome, threadId, runAt);
    await mkdir(threadDirectory, { recursive: true });
    return { codexHome, threadDirectory };
  }

  async function writeVisual(threadDirectory: string, file: string, contents: string | Buffer) {
    const visualPath = path.join(threadDirectory, file);
    await writeFile(visualPath, contents);
    await utimes(visualPath, runAt, runAt);
  }

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("decodes the final Rudder JSON envelope before directive parsing", () => {
    const body = 'Chart\n::codex-inline-vis{file="chart.html"}';
    const summary = `__RUDDER_RESULT_test__${JSON.stringify({ kind: "message", body, structuredPayload: null })}`;
    expect(codexInlineVisualDirectiveBody(summary)).toBe(body);
    expect(codexInlineVisualDirectiveBody(body)).toBe(body);
  });

  it("captures current-thread HTML as persistence-ready metadata without host paths", async () => {
    const { codexHome, threadDirectory } = await fixture();
    const html = '<div id="widget"><button id="go">Run</button></div>';
    await writeVisual(threadDirectory, "simulator.html", html);

    const result = await captureCodexInlineVisuals({
      body: 'Result\n::codex-inline-vis{file="simulator.html"}',
      codexHome,
      threadId,
      startedAt: runAt,
      endedAt: runAt,
    });

    expect(result).toEqual([{
      directiveIndex: 0,
      file: "simulator.html",
      status: "captured",
      contentType: "text/html",
      byteSize: Buffer.byteLength(html),
      bodyBase64: Buffer.from(html).toString("base64"),
    }]);
    expect(JSON.stringify(result)).not.toContain(codexHome);
    expect(JSON.stringify(result)).not.toContain(threadId);
  });

  it("captures multiple directives but enforces the count limit", async () => {
    const { codexHome, threadDirectory } = await fixture();
    await Promise.all([0, 1, 2, 3].map((index) =>
      writeVisual(threadDirectory, `visual-${index}.html`, `<p>${index}</p>`),
    ));
    const body = [0, 1, 2, 3]
      .map((index) => `::codex-inline-vis{file="visual-${index}.html"}`)
      .join("\n");

    const result = await captureCodexInlineVisuals({
      body,
      codexHome,
      threadId,
      startedAt: runAt,
      endedAt: runAt,
    });

    expect(result).toHaveLength(3);
    expect(result.every((entry) => entry.status === "captured")).toBe(true);
  });

  it("returns safe unavailable metadata for missing and oversized files", async () => {
    const { codexHome, threadDirectory } = await fixture();
    await writeVisual(threadDirectory, "large.html", Buffer.alloc(CODEX_INLINE_VISUAL_MAX_BYTES + 1, 65));

    const result = await captureCodexInlineVisuals({
      body: [
        '::codex-inline-vis{file="missing.html"}',
        '::codex-inline-vis{file="large.html"}',
      ].join("\n"),
      codexHome,
      threadId,
      startedAt: runAt,
      endedAt: runAt,
    });

    expect(result).toEqual([
      { directiveIndex: 0, file: "missing.html", status: "unavailable", reason: "missing" },
      { directiveIndex: 1, file: "large.html", status: "unavailable", reason: "too_large" },
    ]);
    expect(JSON.stringify(result)).not.toContain(codexHome);
  });

  it("rejects a file symlink that escapes the current thread directory", async () => {
    const { codexHome, threadDirectory } = await fixture();
    const outside = path.join(codexHome, "secret.html");
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, path.join(threadDirectory, "escape.html"));

    const result = await captureCodexInlineVisuals({
      body: '::codex-inline-vis{file="escape.html"}',
      codexHome,
      threadId,
      startedAt: runAt,
      endedAt: runAt,
    });

    expect(result).toEqual([
      { directiveIndex: 0, file: "escape.html", status: "unavailable", reason: "path_escape" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects a stale file from an earlier turn in the same Codex thread", async () => {
    const { codexHome, threadDirectory } = await fixture();
    const visualPath = path.join(threadDirectory, "stale.html");
    await writeFile(visualPath, "earlier turn", "utf8");
    const staleAt = new Date(runAt.getTime() - 60_000);
    await utimes(visualPath, staleAt, staleAt);

    const result = await captureCodexInlineVisuals({
      body: '::codex-inline-vis{file="stale.html"}',
      codexHome,
      threadId,
      startedAt: runAt,
      endedAt: runAt,
    });

    expect(result).toEqual([
      { directiveIndex: 0, file: "stale.html", status: "unavailable", reason: "out_of_window" },
    ]);
  });

  it("rejects a visualization root symlink that escapes managed CODEX_HOME", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "rudder-inline-vis-home-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "rudder-inline-vis-outside-"));
    cleanup.push(codexHome, outside);
    const outsideThread = path.join(outside, ...[
      String(runAt.getFullYear()),
      String(runAt.getMonth() + 1).padStart(2, "0"),
      String(runAt.getDate()).padStart(2, "0"),
      threadId,
    ]);
    await mkdir(outsideThread, { recursive: true });
    await writeFile(path.join(outsideThread, "secret.html"), "host secret", "utf8");
    await symlink(outside, path.join(codexHome, "visualizations"));

    const result = await captureCodexInlineVisuals({
      body: '::codex-inline-vis{file="secret.html"}',
      codexHome,
      threadId,
      startedAt: runAt,
      endedAt: runAt,
    });

    expect(result).toEqual([
      { directiveIndex: 0, file: "secret.html", status: "unavailable", reason: "path_escape" },
    ]);
    expect(JSON.stringify(result)).not.toContain("host secret");
  });

  it("rejects a thread directory replaced by a symlink before capture", async () => {
    const { codexHome, threadDirectory } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "rudder-inline-vis-thread-outside-"));
    cleanup.push(outside);
    await writeFile(path.join(outside, "secret.html"), "host secret", "utf8");
    await rm(threadDirectory, { recursive: true });
    await symlink(outside, threadDirectory);

    const result = await captureCodexInlineVisuals({
      body: '::codex-inline-vis{file="secret.html"}',
      codexHome,
      threadId,
      startedAt: runAt,
      endedAt: runAt,
    });

    expect(result).toEqual([
      { directiveIndex: 0, file: "secret.html", status: "unavailable", reason: "path_escape" },
    ]);
  });

  it("does not inspect a matching file in another thread or arbitrary directory", async () => {
    const { codexHome } = await fixture();
    const other = codexVisualizationThreadDirectory(codexHome, "other-thread", runAt);
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "chart.html"), "other thread", "utf8");
    await writeFile(path.join(codexHome, "chart.html"), "home secret", "utf8");

    const result = await captureCodexInlineVisuals({
      body: '::codex-inline-vis{file="chart.html"}',
      codexHome,
      threadId,
      startedAt: runAt,
      endedAt: runAt,
    });

    expect(result).toEqual([
      { directiveIndex: 0, file: "chart.html", status: "unavailable", reason: "missing" },
    ]);
  });

  it("ignores invalid paths, attributes, and non-HTML directives", async () => {
    const { codexHome } = await fixture();
    const body = [
      '::codex-inline-vis{file="../escape.html"}',
      '::codex-inline-vis{file="/tmp/escape.html"}',
      '::codex-inline-vis{file="chart.svg"}',
      '::codex-inline-vis{src="chart.html"}',
      '::codex-inline-vis{file="a.html" file="b.html"}',
    ].join("\n");

    const result = await captureCodexInlineVisuals({
      body,
      codexHome,
      threadId,
      startedAt: runAt,
      endedAt: runAt,
    });
    expect(result).toEqual([]);
  });
});

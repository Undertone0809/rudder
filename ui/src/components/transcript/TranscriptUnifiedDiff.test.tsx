// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, TranscriptUnifiedDiff } from "./TranscriptUnifiedDiff";

const TEXT_DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -10,3 +10,4 @@ export function example() {",
  " const safe = true;",
  "-return '<script>alert(1)</script>';",
  "+return '<strong>safe</strong>';",
  "+// added",
  "\\ No newline at end of file",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("preserves headers, hunks, line numbers, no-newline markers, and edit counts", () => {
    const parsed = parseUnifiedDiff(TEXT_DIFF);

    expect(parsed.binary).toBe(false);
    expect(parsed.hasHunks).toBe(true);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
    expect(parsed.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hunk", text: "@@ -10,3 +10,4 @@ export function example() {" }),
      expect.objectContaining({ kind: "context", oldLine: 10, newLine: 10 }),
      expect.objectContaining({ kind: "remove", oldLine: 11, newLine: null }),
      expect.objectContaining({ kind: "add", oldLine: null, newLine: 11 }),
      expect.objectContaining({ kind: "no-newline", text: "\\ No newline at end of file" }),
    ]));
  });

  it("recognizes binary patches as unavailable text diffs", () => {
    const parsed = parseUnifiedDiff("diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ");

    expect(parsed.binary).toBe(true);
    expect(parsed.hasHunks).toBe(false);
  });

  it("does not turn a trailing newline into an extra context row", () => {
    const parsed = parseUnifiedDiff("@@ -1 +1 @@\n-old\n+new\n");

    expect(parsed.lines).toHaveLength(3);
    expect(parsed.lines.at(-1)).toMatchObject({ kind: "add", newLine: 1 });
  });

  it("treats triple-dash and triple-plus content inside a hunk as changed lines", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/example.txt b/example.txt",
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -4,2 +4,2 @@",
      "--- removed content that starts with two dashes",
      "+++ added content that starts with two pluses",
      " unchanged",
    ].join("\n"));

    expect(parsed).toMatchObject({
      additions: 1,
      deletions: 1,
      hasHunks: true,
    });
    expect(parsed.lines[4]).toMatchObject({
      kind: "remove",
      oldLine: 4,
      newLine: null,
    });
    expect(parsed.lines[5]).toMatchObject({
      kind: "add",
      oldLine: null,
      newLine: 4,
    });
    expect(parsed.lines[6]).toMatchObject({
      kind: "context",
      oldLine: 5,
      newLine: 5,
    });
  });
});

describe("TranscriptUnifiedDiff", () => {
  it("renders the historical patch as escaped text with counts and a copy action", () => {
    const html = renderToStaticMarkup(
      <TranscriptUnifiedDiff
        fileName="example.ts"
        diff={TEXT_DIFF}
        truncated
        originalBytes={400_000}
      />,
    );

    expect(html).toContain("example.ts");
    expect(html).toContain("+2");
    expect(html).toContain("-1");
    expect(html).toContain("Copy diff");
    expect(html).toContain("10");
    expect(html).toContain("Historical diff was truncated");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveLocalFileTarget } from "./local-file-targets";

describe("resolveLocalFileTarget", () => {
  it("recognizes local filesystem targets", () => {
    expect(resolveLocalFileTarget("/Users/zeeland/work/result.md")).toBe("/Users/zeeland/work/result.md");
    expect(resolveLocalFileTarget("/Users/zeeland/work/Chat.parts.tsx:656", "Chat.parts.tsx")).toBe("/Users/zeeland/work/Chat.parts.tsx");
    expect(resolveLocalFileTarget("/Users/zeeland/work/Chat.parts.tsx:656:12", "Chat.parts.tsx")).toBe("/Users/zeeland/work/Chat.parts.tsx");
    expect(resolveLocalFileTarget("file:///Users/zeeland/work/result%20copy.md")).toBe("/Users/zeeland/work/result copy.md");
    expect(resolveLocalFileTarget("/Users/zeeland/work/result%20copy.tsx:656", "result copy.tsx")).toBe("/Users/zeeland/work/result copy.tsx");
    expect(resolveLocalFileTarget("/Users/zeeland/work/%E6%96%87%E6%A1%A3.md", "文档.md")).toBe("/Users/zeeland/work/文档.md");
    expect(resolveLocalFileTarget("/srv/rudder/evidence.log")).toBe("/srv/rudder/evidence.log");
    expect(resolveLocalFileTarget("/workspace/output.json")).toBe("/workspace/output.json");
    expect(resolveLocalFileTarget("/root/result.txt")).toBe("/root/result.txt");
    expect(resolveLocalFileTarget("C:\\Users\\zeeland\\work\\result.md")).toBe("C:\\Users\\zeeland\\work\\result.md");
    expect(resolveLocalFileTarget("C:\\Users\\zeeland\\work\\result.tsx:42", "result.tsx")).toBe("C:\\Users\\zeeland\\work\\result.tsx");
    expect(resolveLocalFileTarget("\\\\server\\share\\result.md")).toBe("\\\\server\\share\\result.md");
  });

  it("rejects non-local and ambiguous targets", () => {
    expect(resolveLocalFileTarget("https://example.com/result.md")).toBeNull();
    expect(resolveLocalFileTarget("mailto:test@example.com")).toBeNull();
    expect(resolveLocalFileTarget("result.md")).toBeNull();
    expect(resolveLocalFileTarget("/issues/RUD-43")).toBeNull();
    expect(resolveLocalFileTarget("/library?doc=doc-123")).toBeNull();
    expect(resolveLocalFileTarget("/OUTA/agents/agent-1")).toBeNull();
    expect(resolveLocalFileTarget("/OUTA/projects/project-1")).toBeNull();
    expect(resolveLocalFileTarget("/OUTA/settings/profile")).toBeNull();
    expect(resolveLocalFileTarget("//example.com/result.md")).toBeNull();
    expect(resolveLocalFileTarget("file://attacker/tmp/evidence.md")).toBeNull();
    expect(resolveLocalFileTarget("file://localhost/tmp/evidence.md")).toBeNull();
  });

  it("preserves valid POSIX filenames that end in colon digits", () => {
    expect(resolveLocalFileTarget("/tmp/report:2026", "report:2026")).toBe("/tmp/report:2026");
    expect(resolveLocalFileTarget("/tmp/report:2026")).toBe("/tmp/report:2026");
    expect(resolveLocalFileTarget("/tmp/result%ZZ.tsx", "result%ZZ.tsx")).toBe("/tmp/result%ZZ.tsx");
    expect(resolveLocalFileTarget("file:///tmp/result%ZZ.tsx", "result%ZZ.tsx")).toBeNull();
  });
});

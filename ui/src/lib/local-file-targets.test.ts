// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  resolveLocalFileDisplayTarget,
  resolveLocalFileTarget,
} from "./local-file-targets";

describe("resolveLocalFileTarget", () => {
  it("recognizes local filesystem targets", () => {
    expect(resolveLocalFileTarget("/Users/zeeland/work/result.md")).toBe("/Users/zeeland/work/result.md");
    expect(resolveLocalFileTarget("/Users/zeeland/work/Chat.parts.tsx:656", "Chat.parts.tsx")).toBe("/Users/zeeland/work/Chat.parts.tsx:656");
    expect(resolveLocalFileTarget("/Users/zeeland/work/Chat.parts.tsx:656:12", "Chat.parts.tsx")).toBe("/Users/zeeland/work/Chat.parts.tsx:656:12");
    expect(resolveLocalFileTarget(
      "/Users/zeeland/work/transcripts-and-results.md:40",
      "Transcripts And Results",
    )).toBe("/Users/zeeland/work/transcripts-and-results.md:40");
    expect(resolveLocalFileTarget("file:///Users/zeeland/work/result%20copy.md")).toBe("/Users/zeeland/work/result copy.md");
    expect(resolveLocalFileTarget("/Users/zeeland/work/result%20copy.tsx:656", "result copy.tsx")).toBe("/Users/zeeland/work/result copy.tsx:656");
    expect(resolveLocalFileTarget("/Users/zeeland/work/%E6%96%87%E6%A1%A3.md", "文档.md")).toBe("/Users/zeeland/work/文档.md");
    expect(resolveLocalFileTarget("/srv/rudder/evidence.log")).toBe("/srv/rudder/evidence.log");
    expect(resolveLocalFileTarget("/workspace/output.json")).toBe("/workspace/output.json");
    expect(resolveLocalFileTarget("/root/result.txt")).toBe("/root/result.txt");
    expect(resolveLocalFileTarget("C:\\Users\\zeeland\\work\\result.md")).toBe("C:\\Users\\zeeland\\work\\result.md");
    expect(resolveLocalFileTarget("C:\\Users\\zeeland\\work\\result.tsx:42", "result.tsx")).toBe("C:\\Users\\zeeland\\work\\result.tsx:42");
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
    expect(resolveLocalFileTarget("/api/chats/chat-1")).toBeNull();
    expect(resolveLocalFileTarget("/docs/getting-started")).toBeNull();
    expect(resolveLocalFileTarget("/assets/logo.png")).toBeNull();
    expect(resolveLocalFileTarget("/future-app-route/item-1")).toBeNull();
    expect(resolveLocalFileTarget("//example.com/result.md")).toBeNull();
    expect(resolveLocalFileTarget("file://attacker/tmp/evidence.md")).toBeNull();
    expect(resolveLocalFileTarget("file://localhost/tmp/evidence.md")).toBeNull();
  });

  it("preserves valid POSIX filenames that end in colon digits", () => {
    expect(resolveLocalFileTarget("/tmp/report:2026", "report:2026")).toBe("/tmp/report:2026");
    expect(resolveLocalFileTarget("/tmp/report.md:2026", "report.md:2026")).toBe("/tmp/report.md:2026");
    expect(resolveLocalFileTarget("/tmp/report.md:2026", "Report")).toBe("/tmp/report.md:2026");
    expect(resolveLocalFileTarget("/tmp/report:2026")).toBe("/tmp/report:2026");
    expect(resolveLocalFileTarget("/tmp/result%ZZ.tsx", "result%ZZ.tsx")).toBe("/tmp/result%ZZ.tsx");
    expect(resolveLocalFileTarget("file:///tmp/result%ZZ.tsx", "result%ZZ.tsx")).toBeNull();
  });

  it("strips source locations only for display classification", () => {
    expect(resolveLocalFileDisplayTarget(
      "/Users/zeeland/work/Chat.parts.tsx:656",
      "Chat.parts.tsx",
    )).toBe("/Users/zeeland/work/Chat.parts.tsx");
    expect(resolveLocalFileDisplayTarget(
      "/Users/zeeland/work/transcripts-and-results.md:40",
      "Transcripts And Results",
    )).toBe("/Users/zeeland/work/transcripts-and-results.md");
  });
});

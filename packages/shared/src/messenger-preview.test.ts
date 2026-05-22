import { describe, expect, it } from "vitest";
import { formatMessengerPreview, formatMessengerTitle } from "./messenger-preview.js";

describe("formatMessengerPreview", () => {
  it("turns a markdown heading plus following line into a compact label preview", () => {
    expect(formatMessengerPreview("## 需求\n把 Agent 的处理流程规范化")).toBe("需求: 把 Agent 的处理流程规范化");
  });

  it("strips markdown syntax from regular preview lines", () => {
    expect(formatMessengerPreview("- Render **markdown** in `Messenger` cards")).toBe("Render markdown in Messenger cards");
  });

  it("falls back to the heading text when there is no following content", () => {
    expect(formatMessengerPreview("## Blocked")).toBe("Blocked");
  });

  it("decodes HTML entities and removes long URLs from compact previews", () => {
    expect(
      formatMessengerPreview("&#x20;[https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/] 看一下这个 总结下。"),
    ).toBe("看一下这个 总结下。");
  });

  it("promotes markdown input into clean chat titles", () => {
    expect(
      formatMessengerTitle("&#x20;[https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/] 看一下这个 总结下。"),
    ).toBe("看一下这个 总结下。");
  });

  it("falls back to a compact domain label when a title is only a URL", () => {
    expect(
      formatMessengerTitle("https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/"),
    ).toBe("gingiris.github.io · github readme template guide");
  });
});

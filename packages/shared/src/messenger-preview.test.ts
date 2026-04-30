import { describe, expect, it } from "vitest";
import { formatMessengerPreview } from "./messenger-preview.js";

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
});

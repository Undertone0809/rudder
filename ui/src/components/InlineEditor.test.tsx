// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InlineEditor } from "./InlineEditor";

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => (
    <div data-testid="markdown-body">{children}</div>
  ),
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => <div data-testid="markdown-editor" />,
}));

describe("InlineEditor", () => {
  it("renders multiline markdown as a direct editable surface without hover highlight", () => {
    const html = renderToStaticMarkup(
      <InlineEditor
        value="Issue context"
        onSave={() => undefined}
        multiline
      />,
    );

    expect(html).toContain("cursor-text");
    expect(html).toContain("Issue context");
    expect(html).not.toContain("hover:bg-accent/50");
  });

  it("keeps hover feedback for compact single-line fields", () => {
    const html = renderToStaticMarkup(
      <InlineEditor
        value="Issue title"
        onSave={() => undefined}
      />,
    );

    expect(html).toContain("cursor-pointer");
    expect(html).toContain("hover:bg-accent/50");
  });
});

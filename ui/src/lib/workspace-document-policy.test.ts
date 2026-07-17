import { describe, expect, it } from "vitest";
import {
  containsEmbeddedImageDataUrl,
  displayWorkspaceDocumentKind,
  isWorkspaceCsvContentType,
  isWorkspaceImageFilePath,
  joinYamlFrontmatter,
  splitYamlFrontmatter,
  workspaceImageAssetNamespace,
} from "./workspace-document-policy";

describe("workspace document policy", () => {
  it("classifies file paths and normalized content types", () => {
    expect(displayWorkspaceDocumentKind("notes.MDX")).toBe("MDX");
    expect(displayWorkspaceDocumentKind("data.unknown")).toBe("UNKNOWN");
    expect(isWorkspaceImageFilePath("proof.PNG")).toBe(true);
    expect(isWorkspaceCsvContentType("text/csv; charset=utf-8")).toBe(true);
  });

  it("splits and rejoins YAML frontmatter without changing the separator", () => {
    const parts = splitYamlFrontmatter("---\ntitle: Test\n---\nBody");
    expect(parts).toEqual({
      frontmatter: "---\ntitle: Test\n---",
      frontmatterSeparator: "\n",
      body: "Body",
    });
    expect(joinYamlFrontmatter(parts.frontmatter, parts.frontmatterSeparator, parts.body))
      .toBe("---\ntitle: Test\n---\nBody");
  });

  it("detects embedded images and creates bounded asset namespaces", () => {
    expect(containsEmbeddedImageDataUrl("![x](data:image/png;base64,abc)")).toBe(true);
    expect(containsEmbeddedImageDataUrl("![x](/api/assets/1)")).toBe(false);
    expect(workspaceImageAssetNamespace("drafts/unsafe name.md")).toBe("library/drafts/unsafe_name");
    expect(workspaceImageAssetNamespace(null)).toBe("library/untitled");
  });
});

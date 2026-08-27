import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "App.tsx");
const source = readFileSync(sourcePath, "utf8");

describe("App route code splitting", () => {
  it("keeps route pages out of the eager application graph", () => {
    expect(source).not.toMatch(/from ["']\.\/pages\//u);
    for (const routeModule of [
      "AgentDetail",
      "Chat",
      "IssueDetail",
      "Messenger",
      "OrganizationResources",
      "Plugins",
    ]) {
      expect(source).toContain(`import("./pages/${routeModule}")`);
    }
  });

  it("keeps heavyweight capability packages behind dynamic imports", () => {
    const sourceRoot = path.dirname(sourcePath);
    const cases = [
      ["components/MarkdownBody.tsx", 'import("mermaid")'],
      ["components/WorkspacePdfPreview.tsx", 'import("pdfjs-dist")'],
      ["components/side-panel/TerminalPanelView.tsx", 'import("@xterm/xterm")'],
    ];
    for (const [relativePath, expectedImport] of cases) {
      expect(readFileSync(path.join(sourceRoot, relativePath), "utf8")).toContain(expectedImport);
    }

    const editorSource = readFileSync(path.join(sourceRoot, "components/MarkdownEditor.tsx"), "utf8");
    expect(editorSource).toContain('import("./LegacyMarkdownEditor")');
    expect(editorSource).toContain('import("./MilkdownMarkdownEditor")');
    expect(editorSource).toContain('import("./CodeMirrorMarkdownEditor")');

    const layoutSource = readFileSync(path.join(sourceRoot, "components/Layout.tsx"), "utf8");
    expect(layoutSource).toContain('import("../pages/Chat.side-panel")');
    expect(layoutSource).not.toMatch(/from ["']\.\.\/pages\/Chat\.side-panel["']/u);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

describe("CodeMirror Markdown document surface routing", () => {
  it.each([
    ["pages/OrganizationWorkspaces.tsx", 'engine="codemirror"'],
    ["pages/Chat.side-panel.tsx", 'engine="codemirror"'],
    ["components/workbench/LibraryLiveSurface.tsx", 'engine="codemirror"'],
    ["components/NewIssueDialog.tsx", 'engine="codemirror"'],
    ["pages/IssueDetail.tsx", 'editorEngine="codemirror"'],
    ["pages/Automations.tsx", 'engine="codemirror"'],
    ["pages/AutomationDetail.tsx", 'engine="codemirror"'],
    ["components/NewGoalDialog.tsx", 'engine="codemirror"'],
    ["pages/GoalDetail.tsx", 'editorEngine="codemirror"'],
    ["components/NewProjectDialog.tsx", 'engine="codemirror"'],
    ["components/ProjectProperties.tsx", 'editorEngine="codemirror"'],
  ])("explicitly enables live preview in %s", (relativePath, marker) => {
    expect(source(relativePath)).toContain(marker);
  });

  it.each([
    "components/NewIssueDialog.tsx",
    "pages/Automations.tsx",
    "components/NewGoalDialog.tsx",
    "components/NewProjectDialog.tsx",
  ])("changes document identity between create sessions in %s", (relativePath) => {
    expect(source(relativePath)).toContain("documentIdentity=");
    expect(source(relativePath)).toContain("setDocumentSessionId");
  });

  it("keeps chat composer fields on the explicit plain-text route", () => {
    expect(source("pages/Chat.tsx")).toContain("plainText");
    expect(source("components/side-panel/SideChatPanelView.tsx")).toContain("plainText");
  });

  it("navigates the Library outline through source line positions", () => {
    const librarySource = source("pages/OrganizationWorkspaces.tsx");
    expect(librarySource).toContain(
      "markdownEditorRef.current?.revealLine?.(item.line)",
    );
    expect(librarySource).not.toContain('querySelectorAll("h1,h2,h3,h4,h5,h6")');
    expect(librarySource).toContain(
      "const selectedMarkdownBodyForEditor = selectedMarkdownParts.body",
    );
    expect(librarySource).not.toContain("enrichAgentMentionMarkdown");
  });
});

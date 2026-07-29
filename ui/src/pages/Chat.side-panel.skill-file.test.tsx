import { ThemeProvider } from "@/context/ThemeContext";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatSidePanelSkillFileView } from "./Chat.side-panel";

describe("ChatSidePanelSkillFileView", () => {
  it("renders SKILL.md as a read-only Markdown preview", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <ChatSidePanelSkillFileView
          label="browser"
          file={{
            skillId: "11111111-1111-4111-8111-111111111111",
            path: "SKILL.md",
            kind: "skill",
            content: "---\nname: browser\n---\n\n# Browser Skill\n\nInspect the web.",
            language: "markdown",
            markdown: true,
            editable: false,
          }}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("browser");
    expect(html).toContain("Read only");
    expect(html).toContain("Browser Skill");
    expect(html).toContain('aria-label="Preview skill Markdown"');
    expect(html).toContain('aria-label="View skill Markdown source"');
    expect(html).not.toContain("Save");
    expect(html).not.toContain("Write in Markdown");
  });
});

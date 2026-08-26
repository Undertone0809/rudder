import { describe, expect, it } from "vitest";
import {
  COMMENT_MENTION_PROMPT_TEMPLATE,
  renderTemplate,
  RUDDER_PROMPT_SECTION_TAGS,
  wrapPromptSection,
} from "./server-utils.js";

describe("agent prompt section boundaries", () => {
  it("wraps section content without rewriting internal Markdown", () => {
    const body = "    indented code\n\n- Keep this Markdown.\n- Literal </SOUL.md> stays visible.";

    expect(wrapPromptSection("SOUL.md", body)).toBe(
      `<SOUL.md>\n${body}\n</SOUL.md>`,
    );
    expect(wrapPromptSection("MEMORY.md", "   \n")).toBe("");
  });

  it("separates mention wake metadata from quoted issue and comment content", () => {
    const rendered = renderTemplate(COMMENT_MENTION_PROMPT_TEMPLATE, {
      agent: { id: "agent-1", name: "Reviewer" },
      context: { rudderWorkspace: { orgResourcesPrompt: "" } },
      issue: {
        id: "issue-1",
        title: "Review prompt boundaries",
        status: "in_review",
        assigneeLabel: "Builder",
        reviewerLabel: "Reviewer",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T01:00:00.000Z",
        description: "User-authored issue description.",
      },
      comment: {
        authorLabel: "Operator",
        authorKind: "user",
        body: "Please inspect the invocation boundaries.",
      },
    });

    const wakeStart = rendered.indexOf(`<${RUDDER_PROMPT_SECTION_TAGS.wakeContext}>`);
    const wakeEnd = rendered.indexOf(`</${RUDDER_PROMPT_SECTION_TAGS.wakeContext}>`);
    const quotedStart = rendered.indexOf(`<${RUDDER_PROMPT_SECTION_TAGS.quotedIssueContext}>`);
    const quotedEnd = rendered.indexOf(`</${RUDDER_PROMPT_SECTION_TAGS.quotedIssueContext}>`);
    const descriptionIndex = rendered.indexOf("User-authored issue description.");
    const commentIndex = rendered.indexOf("Please inspect the invocation boundaries.");

    expect(wakeStart).toBe(0);
    expect(wakeEnd).toBeGreaterThan(wakeStart);
    expect(quotedStart).toBeGreaterThan(wakeEnd);
    expect(descriptionIndex).toBeGreaterThan(quotedStart);
    expect(commentIndex).toBeGreaterThan(descriptionIndex);
    expect(quotedEnd).toBeGreaterThan(commentIndex);
    expect(rendered.indexOf("A mention-triggered comment wake")).toBeGreaterThan(quotedEnd);
  });
});

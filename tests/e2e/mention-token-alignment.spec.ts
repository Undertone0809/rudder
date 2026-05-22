import { expect, test } from "@playwright/test";

const TOKEN_TYPES = ["agent", "project", "issue", "skill"] as const;
const SURFACES = ["editor", "markdown"] as const;

test("mention tokens align with surrounding text on every rendered surface", async ({ page }) => {
  await page.goto("/");

  await page.evaluate(() => {
    document.body.innerHTML = `
      <style>
        body {
          margin: 0;
          padding: 48px;
          background: white;
          color: black;
        }
        .alignment-fixture {
          width: 720px;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 16px;
          line-height: 24px;
        }
        .alignment-row {
          margin: 18px 0;
        }
      </style>
      <div class="alignment-fixture">
        <div class="rudder-mdxeditor-content">
          <p class="alignment-row" data-surface="editor">
            <span data-reference-text="editor">Before text</span>
            <a class="rudder-mention-chip rudder-mention-chip--agent" data-token-kind="agent" data-mention-kind="agent" style="--rudder-mention-icon-mask: none;">Wesley</a>
            <a class="rudder-mention-chip rudder-mention-chip--project rudder-project-mention-chip" data-token-kind="project" data-mention-kind="project" style="--rudder-mention-project-color: #f59e0b;">Rudder mkt</a>
            <a class="rudder-mention-chip rudder-mention-chip--issue" data-token-kind="issue" data-mention-kind="issue">ZST-24</a>
            <span class="rudder-skill-token" data-token-kind="skill" data-skill-token="true">build-advisor</span>
            after text.
          </p>
        </div>
        <div class="rudder-markdown">
          <p class="alignment-row" data-surface="markdown">
            <span data-reference-text="markdown">Before text</span>
            <a class="rudder-mention-chip rudder-mention-chip--agent" data-token-kind="agent" data-mention-kind="agent" style="--rudder-mention-icon-mask: none;">Wesley</a>
            <a class="rudder-mention-chip rudder-mention-chip--project rudder-project-mention-chip" data-token-kind="project" data-mention-kind="project" style="--rudder-mention-project-color: #f59e0b;">Rudder mkt</a>
            <a class="rudder-mention-chip rudder-mention-chip--issue" data-token-kind="issue" data-mention-kind="issue">ZST-24</a>
            <span class="rudder-skill-token-wrap">
              <span class="rudder-skill-token" data-token-kind="skill" data-skill-token="true">build-advisor</span>
            </span>
            after text.
          </p>
        </div>
      </div>
    `;
  });

  await page.evaluate(() => document.fonts?.ready);

  for (const surface of SURFACES) {
    const textBox = await page.locator(`[data-reference-text="${surface}"]`).boundingBox();
    expect(textBox, `${surface} reference text should render`).not.toBeNull();
    const textCenter = textBox!.y + textBox!.height / 2;

    for (const type of TOKEN_TYPES) {
      const tokenBox = await page.locator(`[data-surface="${surface}"] [data-token-kind="${type}"]`).boundingBox();
      expect(tokenBox, `${surface} ${type} token should render`).not.toBeNull();
      const tokenCenter = tokenBox!.y + tokenBox!.height / 2;
      expect(Math.abs(tokenCenter - textCenter), `${surface} ${type} token center`).toBeLessThanOrEqual(1.5);
    }
  }
});

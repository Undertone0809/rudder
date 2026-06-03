import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

const TOKEN_TYPES = ["agent", "project", "issue", "chat", "library_doc", "library_file", "skill"] as const;
const SURFACES = ["editor", "milkdown", "markdown"] as const;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APP_STYLESHEET = path.join(REPO_ROOT, "ui/src/index.css");

async function loadAlignmentPage(page: Page, body: string) {
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addStyleTag({ path: APP_STYLESHEET });
  await page.evaluate((markup) => {
    document.body.innerHTML = markup;
  }, body);
  await page.evaluate(() => document.fonts?.ready);
}

test("mention tokens align with surrounding text on every rendered surface", async ({ page }) => {
  await loadAlignmentPage(
    page,
    `
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
          white-space: nowrap;
        }
      </style>
      <div class="alignment-fixture">
        <div class="rudder-mdxeditor-content">
          <p class="alignment-row" data-surface="editor">
            <span data-reference-text="editor">Before text</span>
            <a class="rudder-mention-chip rudder-mention-chip--agent" data-token-kind="agent" data-mention-kind="agent" style="--rudder-mention-icon-mask: none;">Wesley</a>
            <a class="rudder-mention-chip rudder-mention-chip--project rudder-project-mention-chip" data-token-kind="project" data-mention-kind="project" style="--rudder-mention-project-color: #f59e0b;">Rudder mkt</a>
            <a class="rudder-mention-chip rudder-mention-chip--issue" data-token-kind="issue" data-mention-kind="issue">ZST-24</a>
            <a class="rudder-mention-chip rudder-mention-chip--chat" data-token-kind="chat" data-mention-kind="chat">Launch chat</a>
            <a class="rudder-mention-chip rudder-mention-chip--library_doc" data-token-kind="library_doc" data-mention-kind="library_doc">Product doc</a>
            <a class="rudder-mention-chip rudder-mention-chip--library_file" data-token-kind="library_file" data-mention-kind="library_file">product-brief.md</a>
            <span class="rudder-skill-token" data-token-kind="skill" data-skill-token="true">build-advisor</span>
            after text.
          </p>
        </div>
        <div class="rudder-milkdown-content">
          <p class="alignment-row" data-surface="milkdown">
            <span data-reference-text="milkdown">Before text</span>
            <a class="rudder-mention-chip rudder-mention-chip--agent" data-token-kind="agent" data-mention-kind="agent" style="--rudder-mention-icon-mask: none;">Wesley</a>
            <a class="rudder-mention-chip rudder-mention-chip--project rudder-project-mention-chip" data-token-kind="project" data-mention-kind="project" style="--rudder-mention-project-color: #f59e0b;">Rudder mkt</a>
            <a class="rudder-mention-chip rudder-mention-chip--issue" data-token-kind="issue" data-mention-kind="issue">ZST-24</a>
            <a class="rudder-mention-chip rudder-mention-chip--chat" data-token-kind="chat" data-mention-kind="chat">Launch chat</a>
            <a class="rudder-mention-chip rudder-mention-chip--library_doc" data-token-kind="library_doc" data-mention-kind="library_doc">Product doc</a>
            <a class="rudder-mention-chip rudder-mention-chip--library_file" data-token-kind="library_file" data-mention-kind="library_file">product-brief.md</a>
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
            <a class="rudder-mention-chip rudder-mention-chip--chat" data-token-kind="chat" data-mention-kind="chat">Launch chat</a>
            <a class="rudder-mention-chip rudder-mention-chip--library_doc" data-token-kind="library_doc" data-mention-kind="library_doc">Product doc</a>
            <a class="rudder-mention-chip rudder-mention-chip--library_file" data-token-kind="library_file" data-mention-kind="library_file">product-brief.md</a>
            <span class="rudder-skill-token-wrap">
              <span class="rudder-skill-token" data-token-kind="skill" data-skill-token="true">build-advisor</span>
            </span>
            after text.
          </p>
        </div>
      </div>
    `,
  );

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

    const libraryFileStyles = await page
      .locator(`[data-surface="${surface}"] [data-token-kind="library_file"]`)
      .evaluate((element) => {
        const styles = getComputedStyle(element);
        return {
          backgroundColor: styles.backgroundColor,
          borderTopStyle: styles.borderTopStyle,
          borderTopWidth: styles.borderTopWidth,
          color: styles.color,
        };
      });
    expect(libraryFileStyles.backgroundColor, `${surface} library file background`).toBe("rgba(0, 0, 0, 0)");
    expect(libraryFileStyles.borderTopStyle, `${surface} library file border style`).toBe("none");
    expect(libraryFileStyles.borderTopWidth, `${surface} library file border width`).toBe("0px");
    expect(libraryFileStyles.color, `${surface} library file link color`).toBe("rgb(37, 99, 235)");

    for (const type of TOKEN_TYPES) {
      const fontWeight = await page
        .locator(`[data-surface="${surface}"] [data-token-kind="${type}"]`)
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontWeight));
      expect(fontWeight, `${surface} ${type} token weight`).toBeLessThanOrEqual(500);
    }
  }
});

test("composer reference tokens align inside the chat input line", async ({ page }) => {
  await loadAlignmentPage(
    page,
    `
      <style>
        body {
          margin: 0;
          padding: 48px;
          background: white;
          color: black;
        }
        .composer-alignment-fixture {
          width: 2200px;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 15px;
          line-height: 28px;
        }
        .composer-alignment-fixture p {
          white-space: nowrap;
        }
      </style>
      <div class="chat-composer composer-alignment-fixture">
        <div class="rudder-mdxeditor-content" data-surface="composer">
          <p>
            <span data-reference-text="composer">你能看到里面的内容吗?</span>
            <a class="rudder-mention-chip rudder-mention-chip--agent" data-token-kind="agent" data-mention-kind="agent" style="--rudder-mention-icon-mask: none;">Wesley</a>
            <a class="rudder-mention-chip rudder-mention-chip--project rudder-project-mention-chip" data-token-kind="project" data-mention-kind="project" style="--rudder-mention-project-color: #f59e0b;">Rudder dev</a>
            <a class="rudder-mention-chip rudder-mention-chip--issue" data-token-kind="issue" data-mention-kind="issue">ZST-363 issue update 的内容太粗了</a>
            <a class="rudder-mention-chip rudder-mention-chip--chat" data-token-kind="chat" data-mention-kind="chat">Chat update</a>
            <a class="rudder-mention-chip rudder-mention-chip--library_doc" data-token-kind="library_doc" data-mention-kind="library_doc">Project context</a>
            <a class="rudder-mention-chip rudder-mention-chip--library_file" data-token-kind="library_file" data-mention-kind="library_file">product-brief.md</a>
            <span class="rudder-skill-token" data-token-kind="skill" data-skill-token="true">你有权限创建一个新项目吗?</span>
          </p>
        </div>
      </div>
    `,
  );

  const textBox = await page.locator('[data-reference-text="composer"]').boundingBox();
  expect(textBox, "composer reference text should render").not.toBeNull();
  const textCenter = textBox!.y + textBox!.height / 2;
  for (const type of TOKEN_TYPES) {
    const tokenBox = await page.locator(`[data-surface="composer"] [data-token-kind="${type}"]`).boundingBox();
    expect(tokenBox, `composer ${type} token should render`).not.toBeNull();
    const tokenCenter = tokenBox!.y + tokenBox!.height / 2;
    expect(Math.abs(tokenCenter - textCenter), `composer ${type} token center`).toBeLessThanOrEqual(1.5);

    const fontWeight = await page
      .locator(`[data-surface="composer"] [data-token-kind="${type}"]`)
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontWeight));
    expect(fontWeight, `composer ${type} token weight`).toBeLessThanOrEqual(500);
  }

  const tokenTextBox = await page.locator('[data-surface="composer"] [data-token-kind="skill"]').evaluate((element) => {
    const textNode = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    if (!textNode) return null;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const box = range.getBoundingClientRect();
    range.detach();
    return { y: box.y, height: box.height };
  });
  expect(tokenTextBox, "composer skill token text should render").not.toBeNull();

  const tokenTextCenter = tokenTextBox!.y + tokenTextBox!.height / 2;
  expect(Math.abs(tokenTextCenter - textCenter), "composer skill token text center").toBeLessThanOrEqual(1);
});

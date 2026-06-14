import { expect, test } from "@playwright/test";

async function createUiLabOrganization(page: import("@playwright/test").Page) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `UI Lab ${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  return organization;
}

test.describe("UI Lab", () => {
  test("renders common components, coverage search, and legacy lab routes", async ({ page }) => {
    const organization = await createUiLabOrganization(page);

    await page.goto(`/${organization.issuePrefix}/ui-lab`);

    await expect(page.getByRole("heading", { name: "UI Lab" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Common Components/ })).toBeVisible();

    await page.getByRole("button", { name: /Common Components/ }).click();
    await expect(page.getByText("Status, priority, and rows")).toBeVisible();
    await expect(page.getByText("Identity and assignees")).toBeVisible();
    await expect(page.getByText("Metric cards")).toBeVisible();
    await expect(page.getByText("Activity, timestamps, copy, and progress")).toBeVisible();
    await expect(page.getByText("Issue rows and agent actions")).toBeVisible();
    await expect(page.getByText("Approval card")).toBeVisible();
    await expect(page.getByText("Agent avatar, picker, and properties")).toBeVisible();
    await expect(page.getByText("Charts, selectors, and sidebar rows")).toBeVisible();
    await expect(page.getByText("Schema form")).toBeVisible();
    await expect(page.getByText("File tree")).toBeVisible();
    await expect(page.locator('[data-mention-kind="agent"]').getByText("Holden")).toBeVisible();
    await expect(page.getByText("Chat prompts, messages, and process states")).toBeVisible();
    await expect(page.getByText("Chat composer surface")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Plan mode" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible();
    await expect(page.getByText("Create or activate an agent before sending messages.")).toBeVisible();
    await expect(page.getByText("Chat attachments, rich references, and input requests")).toBeVisible();
    await expect(page.getByText("Input needed")).toBeVisible();
    await expect(page.getByTestId("chat-ask-user-answer").getByText("Answered")).toBeVisible();
    await expect(page.getByText("Attachment list")).toBeVisible();
    await page.getByRole("button", { name: "Open image preview: chat-preview.svg" }).first().click();
    await expect(page.getByTestId("chat-image-preview-dialog")).toBeVisible();
    await expect(page.getByRole("img", { name: "chat-preview.svg" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Goal and project properties")).toBeVisible();
    await expect(page.getByText("Budget and finance cards")).toBeVisible();
    await expect(page.getByText("RUD-214").first()).toBeVisible();
    await expect(page.getByText("Reviewer Agent", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: /Coverage/ }).click();
    await page.getByPlaceholder("Search components, paths, or statuses").fill("RunTranscriptView");
    await expect(page.getByRole("cell", { name: "RunTranscriptView", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Fixture-backed" })).toBeVisible();

    await page.getByPlaceholder("Search components, paths, or statuses").fill("JsonSchemaForm");
    await expect(page.getByRole("cell", { name: "JsonSchemaForm", exact: true })).toBeVisible();

    await page.getByPlaceholder("Search components, paths, or statuses").fill("WorkspaceBackupFilesSidebar");
    await expect(page.getByRole("cell", { name: "WorkspaceBackupFilesSidebar", exact: true })).toBeVisible();

    await page.getByPlaceholder("Search components, paths, or statuses").fill("ChatMessageItem");
    await expect(page.getByRole("cell", { name: "ChatMessageItem", exact: true })).toBeVisible();

    await page.getByPlaceholder("Search components, paths, or statuses").fill("ChatAttachmentList");
    await expect(page.getByRole("cell", { name: "ChatAttachmentList", exact: true })).toBeVisible();

    await page.getByPlaceholder("Search components, paths, or statuses").fill("ChatComposerSurface");
    await expect(page.getByRole("cell", { name: "ChatComposerSurface", exact: true })).toBeVisible();

    await page.goto(`/${organization.issuePrefix}/design-guide`);
    await expect(page.getByText("Existing design guide")).toBeVisible();
    await expect(page.getByText("Component Coverage")).toBeVisible();

    await page.goto(`/${organization.issuePrefix}/tests/ux/runs`);
    await expect(page.getByText("Run transcript UX lab")).toBeVisible();
    await expect(page.getByText("Run Transcript Fixtures")).toBeVisible();

    await page.locator("button").filter({ hasText: /^compact$/i }).click();
    await page.locator("button").filter({ hasText: "Issue Widget" }).click();
    await expect(page.getByText("I’m validating the generic tool row", { exact: false })).toBeVisible();
    await expect(page.getByText("Spawned explorer agent: Inspect the transcript renderer for Codex sub-agent rows.", { exact: false })).toBeVisible();
    await expect(page.getByText("gpt-5.3-codex, high reasoning, forked context", { exact: false })).toBeVisible();

    const genericToolRow = page.locator("button").filter({ hasText: /^Tool/ });
    await expect(genericToolRow).toBeVisible();
    const metrics = await genericToolRow.evaluate((button) => {
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect();
        return {
          bottom: box.bottom,
          centerY: box.top + box.height / 2,
          top: box.top,
        };
      };
      const icon = button.querySelector('[data-transcript-action-icon-slot="true"]');
      const label = Array.from(button.querySelectorAll("span"))
        .find((element) => element.textContent?.trim() === "Tool");
      const next = Array.from(document.querySelectorAll("body *"))
        .filter((element) => element.textContent?.includes("I’m delegating a focused transcript check"))
        .sort((left, right) => (left.textContent?.length ?? 0) - (right.textContent?.length ?? 0))[0];
      const wrapper = button.parentElement;
      if (!icon || !label || !next || !wrapper) {
        throw new Error("Generic transcript tool row geometry target missing");
      }
      return {
        buttonClass: button.getAttribute("class") ?? "",
        iconLabelCenterDelta: Math.abs(rect(icon).centerY - rect(label).centerY),
        rowToNextGap: rect(next).top - rect(wrapper).bottom,
        wrapperClass: wrapper.getAttribute("class") ?? "",
      };
    });
    expect(metrics.buttonClass).toContain("items-center");
    expect(metrics.buttonClass).toContain("gap-1.5");
    expect(metrics.wrapperClass).toContain("py-0.5");
    expect(metrics.iconLabelCenterDelta).toBeLessThanOrEqual(1);
    expect(metrics.rowToNextGap).toBeLessThanOrEqual(6);

    await page.locator("button").filter({ hasText: "Chat Transcript" }).click();
    await expect(page.locator('[data-transcript-file-change="true"]').first()).toBeVisible();
    await expect(page.getByText("File Change", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Updated rudder/proposals/2026-06-10-rudder-cli-capability-parity.md", { exact: false })).toBeVisible();
    await expect(page.getByText("/Users/zeeland/.rudder/instances/default/organizations/org/workspaces/projects/rudder/proposals", { exact: false })).toHaveCount(0);
    await page.locator('[data-transcript-file-change="true"] button').first().click();
    await expect(page.getByText("/Users/zeeland/.rudder/instances/default/organizations/org/workspaces/projects/rudder/proposals", { exact: false })).toBeVisible();
  });

  test("renders Markdown website links as icon chips", async ({ page }) => {
    const organization = await createUiLabOrganization(page);

    await page.goto(`/${organization.issuePrefix}/ui-lab`);
    await page.getByRole("button", { name: /Common Components/ }).click();

    const websiteLinkChip = page.locator("a.rudder-link-chip--website").filter({ hasText: "Rudder docs" });
    await expect(websiteLinkChip).toBeVisible();
    await expect(websiteLinkChip).toHaveAttribute("href", "https://doc.rudder.zeeland.studio");
    await expect(websiteLinkChip).toHaveAttribute("target", "_blank");
    await expect(websiteLinkChip.locator(".rudder-link-chip-icon")).toBeVisible();
    await expect(websiteLinkChip.locator(".rudder-link-chip-domain")).toHaveText("Rudder docs");
    await expect(websiteLinkChip.locator(".rudder-link-chip-detail")).toHaveText("doc.rudder.zeeland.studio");
  });

  test("shows a hover copy action on command terminal transcript details", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const organization = await createUiLabOrganization(page);

    await page.goto(`/${organization.issuePrefix}/tests/ux/runs`);
    await expect(page.getByText("Run transcript UX lab")).toBeVisible();
    await expect(page.getByText("Run Transcript Fixtures")).toBeVisible();

    await page.getByRole("button", { name: "Expand tool activity group 1" }).click();
    const docGoalCommand = page.getByRole("button", { name: "Expand command details" }).filter({ hasText: "Read doc/GOAL.md" });
    await expect(docGoalCommand).toHaveCount(1);
    await docGoalCommand.click();

    const commandTerminal = page.getByTestId("command-terminal-detail").first();
    const commandCopyButton = page.getByTestId("command-terminal-copy-button").first();
    await expect(commandTerminal).toBeVisible();
    await expect(commandCopyButton).toHaveCSS("opacity", "0");
    await commandTerminal.hover();
    await expect(commandCopyButton).toHaveCSS("opacity", "1");
    await commandCopyButton.click();
    await expect(commandCopyButton).toHaveAttribute("data-copy-state", "copied");

    const copiedCommandOutput = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedCommandOutput).toContain("sed -n '1,220p' doc/GOAL.md");
    expect(copiedCommandOutput).not.toContain("$ sed");
  });
});

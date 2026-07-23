import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function createUiLabOrganization(page: import("@playwright/test").Page) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `UI Lab ${Date.now()}`,
      issuePrefix: `UIL${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
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
  test("renders shared liquid glass variants without changing transient-surface interaction", async ({ page }) => {
    test.setTimeout(120_000);
    const organization = await createUiLabOrganization(page);

    await page.goto(`/${organization.issuePrefix}/ui-lab`);
    await page.getByRole("button", { name: /^Design Guide/ }).click();

    await expect(page.getByRole("heading", { name: "Liquid Glass Transient Surfaces" })).toBeVisible();
    await expect(page.locator("[data-liquid-glass-sample='modal'] [data-rudder-liquid-glass]"))
      .toHaveAttribute("data-liquid-glass-variant", "modal");
    await expect(page.locator("[data-liquid-glass-sample='menu'] [data-rudder-liquid-glass]"))
      .toHaveAttribute("data-liquid-glass-variant", "menu");
    await expect(page.locator("[data-liquid-glass-sample='preview'] [data-rudder-liquid-glass]"))
      .toHaveAttribute("data-liquid-glass-variant", "preview");

    const quickActions = page.getByRole("button", { name: "Quick Actions" });
    await quickActions.focus();
    await page.keyboard.press("Enter");
    const menu = page.locator("[data-slot='dropdown-menu-content']");
    await expect(menu).toBeVisible();
    await expect(menu.locator(":scope > [data-rudder-liquid-glass]"))
      .toHaveAttribute("data-liquid-glass-variant", "menu");
    await expect(page.getByRole("menuitem", { name: /Mark as done/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: /Open docs/ })).toBeFocused();
    const materialBeforeScroll = await menu.evaluate((element) => ({
      backdropFilter: getComputedStyle(element).backdropFilter,
      bounds: element.getBoundingClientRect().toJSON(),
    }));
    await page.getByRole("menuitem", { name: "View activity" }).scrollIntoViewIfNeeded();
    const materialAfterScroll = await menu.evaluate((element) => ({
      backdropFilter: getComputedStyle(element).backdropFilter,
      bounds: element.getBoundingClientRect().toJSON(),
    }));
    expect(materialBeforeScroll.backdropFilter).toContain("url(");
    expect(materialAfterScroll.backdropFilter).toBe(materialBeforeScroll.backdropFilter);
    expect(
      Math.abs(materialAfterScroll.bounds.height - materialBeforeScroll.bounds.height),
    ).toBeLessThanOrEqual(1);
    expect(Number.isFinite(materialAfterScroll.bounds.y)).toBe(true);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Open Dialog" }).click();
    const dialog = page.locator("[data-slot='dialog-content']");
    const dialogGlass = dialog.locator(":scope > [data-rudder-liquid-glass]");
    await expect(dialogGlass).toHaveAttribute("data-liquid-glass-variant", "modal");
    await expect(dialogGlass).toHaveCSS("pointer-events", "none");
    await expect(dialog).toHaveCSS("position", "fixed");
    await expect(dialog.locator("[data-slot='dialog-close']")).toHaveCSS("position", "absolute");
    const dialogBounds = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(dialogBounds).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(Math.abs(
      (dialogBounds?.x ?? 0) + (dialogBounds?.width ?? 0) / 2 - (viewport?.width ?? 0) / 2,
    )).toBeLessThanOrEqual(2);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Hover me" }).hover();
    const tooltip = page.locator("[data-slot='tooltip-content']");
    await expect(tooltip.locator(":scope > [data-rudder-liquid-glass]"))
      .toHaveAttribute("data-liquid-glass-variant", "tooltip");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(tooltip.locator(":scope > [data-rudder-liquid-glass]"))
      .toHaveCSS("animation-name", "none");

    await page.screenshot({ path: "/tmp/rudder-liquid-glass-ui-lab.png", fullPage: true });
  });

  test("applies shared motion defaults and honors reduced motion", async ({ page }) => {
    const organization = await createUiLabOrganization(page);

    await page.goto(`/${organization.issuePrefix}/ui-lab`);
    await page.getByRole("button", { name: /Primitives/ }).click();
    await page.getByRole("tab", { name: "Loading" }).click();

    const skeleton = page.locator('[data-slot="skeleton"]').first();
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveClass(/motion-skeleton/);
    await expect(skeleton).not.toHaveCSS("animation-name", "none");

    await page.screenshot({ path: "/tmp/rudder-motion-defaults-ui-lab.png", fullPage: true });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(skeleton).toHaveCSS("animation-name", "none");
  });

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

    await page.locator("button").filter({ hasText: "Run Detail" }).click();
    const fileChange = page.locator('[data-transcript-file-change="true"]');
    await expect(fileChange).toHaveCount(1);
    await expect(page.getByText(/^File change$/i)).toHaveCount(1);
    await expect(fileChange).toContainText("Updated rudder/proposals/2026-06-10-rudder-cli-capability-parity.md");
    await expect(page.getByText("/Users/zeeland/.rudder/instances/default/organizations/org/workspaces/projects/rudder/proposals", { exact: false })).toHaveCount(0);
    const fileChangeDisclosure = fileChange.locator("button");
    await expect(fileChangeDisclosure).toHaveAttribute("aria-label", "Expand file change details: Updated rudder/proposals/2026-06-10-rudder-cli-capability-parity.md");
    await fileChangeDisclosure.click();
    await expect(fileChangeDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(fileChangeDisclosure).toHaveAttribute("aria-label", "Collapse file change details: Updated rudder/proposals/2026-06-10-rudder-cli-capability-parity.md");
    await expect(fileChange.getByText("file changes:", { exact: false })).toBeVisible();
  });

  test("renders Markdown website links as inline icon-leading text", async ({ page }) => {
    const organization = await createUiLabOrganization(page);
    await page.addInitScript(() => window.localStorage.setItem("rudder.theme", "dark"));
    await page.route("**/api/website-metadata?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const targetUrl = requestUrl.searchParams.get("url");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: targetUrl,
          siteName: targetUrl?.includes("docs.rudderhq") ? "Rudder docs" : null,
          iconUrl: targetUrl?.includes("docs.rudderhq") ? "/rudder-logo.png" : null,
        }),
      });
    });

    await page.goto(`/${organization.issuePrefix}/ui-lab`);
    await page.getByRole("button", { name: /Common Components/ }).click();

    const websiteLink = page.locator("a.rudder-website-link").filter({ hasText: "Rudder docs" });
    const openAiLink = page.locator("a.rudder-website-link").filter({ hasText: "OpenAI docs" });
    const fallbackLink = page.locator("a.rudder-website-link").filter({ hasText: "reference guide" });
    await expect(websiteLink).toBeVisible();
    await expect(openAiLink).toBeVisible();
    await expect(fallbackLink).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(websiteLink).toHaveAttribute("href", "https://docs.rudderhq.dev");
    await expect(websiteLink).toHaveAttribute("target", "_blank");
    await expect(websiteLink.locator("img.rudder-website-link-logo")).toHaveAttribute("src", /^data:image\/x-icon;base64,/u);
    await expect(websiteLink.locator(".rudder-website-link-label")).toHaveText("Rudder docs");
    await expect(openAiLink.locator("img.rudder-website-link-logo")).toHaveAttribute("data-dark-mode", "invert");
    await expect(openAiLink.locator("img.rudder-website-link-logo")).toHaveCSS("filter", "invert(1)");
    await expect(websiteLink.locator("img.rudder-website-link-logo")).toHaveCSS("filter", "none");
    await expect(fallbackLink.locator('[data-website-icon="generic"]')).toBeVisible();
    await expect(fallbackLink.locator(".rudder-website-link-label")).toHaveText("reference guide");
    await expect(page.locator("a.rudder-link-chip--website")).toHaveCount(0);
    await expect(websiteLink.locator(".rudder-link-chip-domain")).toHaveCount(0);
    await expect(websiteLink.locator(".rudder-link-chip-detail")).toHaveCount(0);

    const render = await websiteLink.evaluate((link) => {
      const style = window.getComputedStyle(link);
      const icon = link.querySelector(".rudder-website-link-icon");
      const logo = link.querySelector("img.rudder-website-link-logo");
      const iconStyle = icon ? window.getComputedStyle(icon) : null;
      return {
        backgroundImage: style.backgroundImage,
        borderTopWidth: style.borderTopWidth,
        borderRadius: style.borderRadius,
        display: style.display,
        iconDisplay: iconStyle?.display,
        iconHeight: icon ? icon.getBoundingClientRect().height : null,
        iconWidth: icon ? icon.getBoundingClientRect().width : null,
        logoExists: Boolean(logo),
        paddingInlineEnd: style.paddingInlineEnd,
        paddingInlineStart: style.paddingInlineStart,
      };
    });
    expect(render).toMatchObject({
      backgroundImage: "none",
      borderTopWidth: "0px",
      borderRadius: "0px",
      display: "inline-flex",
      iconDisplay: "flex",
      logoExists: true,
      paddingInlineEnd: "0px",
      paddingInlineStart: "0px",
    });
    expect(render.iconHeight).toBeGreaterThan(10);
    expect(render.iconHeight).toBeLessThan(18);
    expect(render.iconWidth).toBeGreaterThan(10);
    expect(render.iconWidth).toBeLessThan(18);
  });

  test("shows a hover copy action on command terminal transcript details", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const organization = await createUiLabOrganization(page);

    await page.goto(`/${organization.issuePrefix}/tests/ux/runs`);
    await expect(page.getByText("Run transcript UX lab")).toBeVisible();
    await expect(page.getByText("Run Transcript Fixtures")).toBeVisible();

    await page.getByRole("button", { name: "Expand tool activity group 1" }).click();
    const docGoalCommand = page.getByRole("button", { name: "Expand command details" }).filter({ hasText: "Read doc/product/GOAL.md" });
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
    expect(copiedCommandOutput).toContain("sed -n '1,220p' doc/product/GOAL.md");
    expect(copiedCommandOutput).not.toContain("$ sed");
  });
});

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
  test("keeps transcript durations aligned across mixed activity rows", async ({ page }) => {
    const organization = await createUiLabOrganization(page);

    await page.goto(`/${organization.issuePrefix}/tests/ux/runs`);
    await expect(page.getByRole("heading", { name: "Run Detail" })).toBeVisible();
    await page.getByRole("button", { name: "Show settled state" }).click();
    await expect(page.getByRole("button", { name: "Show streaming state" })).toBeVisible();

    const assertDurationColumn = async (minimumCount: number) => {
      const durationLabels = page.locator("[data-transcript-action-duration='true']");
      await expect.poll(() => durationLabels.count()).toBeGreaterThanOrEqual(minimumCount);
      const durationTexts = await durationLabels.allTextContents();
      expect(durationTexts).toEqual(expect.arrayContaining(["100ms", "60ms", "5ms", "23s", "16s", "354ms"]));
      const durationRightEdges = await durationLabels.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
      expect(Math.max(...durationRightEdges) - Math.min(...durationRightEdges)).toBeLessThanOrEqual(1);
    };

    await assertDurationColumn(6);
    await expect(page.getByRole("button", { name: /Expand command details: Ran pnpm test:run$/ })).toBeVisible();

    await page.getByRole("button", { name: /Expand tool activity group 6/ }).click();
    await assertDurationColumn(9);

    await page.screenshot({ path: "/tmp/rudder-run-transcript-duration-aligned.png", fullPage: true });
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
    await expect(page.getByText("Special message cards", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Input needed to continue" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Request completed" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agent run failed" })).toBeVisible();
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
    await expect(page.getByText("Input needed", { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-ask-user-answer").getByText("Answered")).toBeVisible();
    await expect(page.getByText("Attachment list")).toBeVisible();
    await page.getByRole("button", { name: "Open image preview: chat-preview.svg" }).first().click();
    await expect(page.getByTestId("chat-image-preview-dialog")).toBeVisible();
    await expect(page.getByRole("img", { name: "chat-preview.svg" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Project properties")).toBeVisible();
    await expect(page.getByText("Budget and finance cards")).toBeVisible();
    await expect(page.getByText("RUD-214").first()).toBeVisible();
    await expect(page.getByText("Reviewer Agent", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: /Coverage/ }).click();
    await page.getByPlaceholder("Search components, paths, or statuses").fill("RunTranscriptView");
    const runTranscriptCoverageRow = page.getByRole("row").filter({
      has: page.getByRole("cell", { name: "RunTranscriptView", exact: true }),
    });
    await expect(runTranscriptCoverageRow).toBeVisible();
    await expect(runTranscriptCoverageRow.getByRole("cell", { name: "Fixture-backed" })).toBeVisible();

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

    await page.getByRole("button", { name: /MCP Cards/ }).click();
    const semanticCardsLab = page.getByTestId("ui-lab-rudder-mcp-cards");
    await expect(semanticCardsLab.getByText("Entity cards", { exact: true })).toBeVisible();
    for (const domain of ["agent", "issue", "goal", "project", "approval", "automation"]) {
      await expect(semanticCardsLab.getByTestId(`ui-lab-${domain}-card`)).toBeVisible();
    }
    await expect(semanticCardsLab.getByTestId("ui-lab-agent-card")).toContainText("OpenAI · gpt-5.4 · Codex (local)");
    await expect(semanticCardsLab.getByTestId("ui-lab-issue-card").locator('[data-slot="issue-status-icon"]')).toHaveAttribute("data-status", "in_progress");
    await expect(semanticCardsLab.getByText("Horizontal result rail")).toBeVisible();
    const semanticLabRail = semanticCardsLab.locator('[data-rudder-semantic-rail="goal"]');
    await expect(semanticLabRail).toBeVisible();
    await expect(semanticLabRail.locator('[data-rudder-semantic-card-surface="true"]')).toHaveCount(6);
    await expect(semanticCardsLab.locator('[data-rudder-semantic-card-surface="true"]')).toHaveCount(20);
    await semanticLabRail.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expect(semanticLabRail.locator('[data-rudder-semantic-card-surface="true"]')).toHaveCount(12);
    await semanticLabRail.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expect(semanticLabRail.locator('[data-rudder-semantic-card-surface="true"]')).toHaveCount(13);
    await expect(semanticCardsLab.getByText("The horizontal rail reads clearly now.", { exact: false })).toBeVisible();
    await expect(semanticCardsLab.getByText("Approved for the review branch.", { exact: false })).toBeVisible();
    await expect(semanticCardsLab.locator('[data-rudder-semantic-agent="true"]').first()).toContainText("Mira Chen");
    await expect(semanticCardsLab.getByTestId("ui-lab-trigger-delete-receipt").locator('a[href$="/automations/automation-lab-1"]')).toBeVisible();
    const semanticSurfaceStyle = await semanticCardsLab.locator('[data-rudder-semantic-card-surface="true"]').first().evaluate((element) => {
      const style = window.getComputedStyle(element);
      return { boxShadow: style.boxShadow, transitionProperty: style.transitionProperty };
    });
    expect(semanticSurfaceStyle.boxShadow).not.toBe("none");
    expect(semanticSurfaceStyle.transitionProperty).toContain("border-color");
    expect(semanticSurfaceStyle.transitionProperty).not.toContain("transform");
    const firstSemanticSurface = semanticCardsLab.locator('[data-rudder-semantic-card-link="true"]').first();
    const restingSurfaceStyle = await firstSemanticSurface.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        transform: style.transform,
      };
    });
    await firstSemanticSurface.hover();
    await expect(firstSemanticSurface).toHaveAttribute("data-rudder-semantic-card-interactive", "true");
    await expect.poll(() => firstSemanticSurface.evaluate((element, resting) => {
      const style = window.getComputedStyle(element);
      return {
        borderChanged: style.borderColor !== resting.borderColor,
        backgroundUnchanged: style.backgroundColor === resting.backgroundColor,
        shadowUnchanged: style.boxShadow === resting.boxShadow,
        transformUnchanged: style.transform === resting.transform,
      };
    }, restingSurfaceStyle)).toEqual({
      backgroundUnchanged: true,
      borderChanged: true,
      shadowUnchanged: true,
      transformUnchanged: true,
    });
    const markdownComment = semanticCardsLab.getByTestId("ui-lab-issue-comment-receipt");
    await expect(markdownComment.locator("strong")).toContainText("The horizontal rail reads clearly now.");
    await expect(markdownComment.locator("li")).toHaveCount(2);
    const receiptActionBox = await markdownComment.locator('[data-rudder-semantic-action="true"]').boundingBox();
    const receiptMetaBox = await markdownComment.locator('[data-rudder-semantic-receipt-meta="true"]').boundingBox();
    expect(receiptActionBox).not.toBeNull();
    expect(receiptMetaBox).not.toBeNull();
    expect(receiptActionBox!.y + receiptActionBox!.height).toBeLessThanOrEqual(receiptMetaBox!.y + 1);
    const longComment = semanticCardsLab
      .getByTestId("ui-lab-long-comment-receipt")
      .locator('[data-rudder-semantic-comment-body="true"]');
    await expect(longComment).toContainText("Review note 48:");
    await expect(longComment).toContainText("End of complete long comment fixture.");
    await expect(longComment).toContainText("<script data-semantic-raw-html-probe>not executable</script>");
    await expect(longComment.locator("script[data-semantic-raw-html-probe]")).toHaveCount(0);
    const longCommentGeometry = await longComment.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      text: element.textContent,
    }));
    expect(longCommentGeometry.scrollHeight).toBeGreaterThan(longCommentGeometry.clientHeight);
    expect(longCommentGeometry.clientHeight).toBeLessThanOrEqual(160);
    expect(longCommentGeometry.text).toContain("Review note 1:");
    expect(longCommentGeometry.text).toContain("Review note 48:");
    expect(longCommentGeometry.text).toContain("End of complete long comment fixture.");

    await page.locator("button").filter({ hasText: "Chat Transcript" }).click();
    const chatTranscript = page.getByTestId("ui-lab-chat-transcript");
    for (const name of [/List goals/i, /Add issue comment/i, /Add approval comment/i, /Run automation/i]) {
      const row = chatTranscript.getByRole("button", {
        name: new RegExp(`Expand tool details: .*${name.source}`, "i"),
      });
      await expect(row).toBeVisible();
      await row.click();
    }
    await expect(chatTranscript.locator('[data-rudder-semantic-presenter]')).toHaveCount(4);
    await expect(chatTranscript.getByText("The horizontal rail reads clearly now.", { exact: false })).toBeVisible();
    await expect(chatTranscript.getByText("Approved for the review branch.", { exact: false })).toBeVisible();

    await page.locator("button").filter({ hasText: "Issue Widget" }).click();
    await page.locator("button").filter({ hasText: /^compact$/i }).click();
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
    const runDetailTranscript = page.getByTestId("ui-lab-run-detail-transcript");
    for (const name of [/List goals/i, /Add issue comment/i, /Add approval comment/i, /Run automation/i]) {
      const row = runDetailTranscript.getByRole("button", {
        name: new RegExp(`Expand tool details: .*${name.source}`, "i"),
      });
      await expect(row).toBeVisible();
      await row.click();
    }
    await expect(runDetailTranscript.locator('[data-rudder-semantic-presenter]')).toHaveCount(4);
    await expect(runDetailTranscript.getByText("The horizontal rail reads clearly now.", { exact: false })).toBeVisible();
    await expect(runDetailTranscript.getByText("Approved for the review branch.", { exact: false })).toBeVisible();
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

  test("keeps website icon state and keyboard activation aligned when a Markdown link rerenders", async ({ page, context }, testInfo) => {
    const organization = await createUiLabOrganization(page);
    const firstUrl = "https://website-icon-rerender-first.example.test/article";
    const secondUrl = "https://website-icon-rerender-second.example.test/article";
    const firstIconUrl = `/api/website-metadata/icon?url=${encodeURIComponent(`${firstUrl}.ico`)}`;
    const secondIconUrl = `/api/website-metadata/icon?url=${encodeURIComponent(`${secondUrl}.ico`)}`;
    let releaseSecondMetadata: (() => void) | null = null;
    const secondMetadata = new Promise<void>((resolve) => {
      releaseSecondMetadata = resolve;
    });

    await page.route("**/api/website-metadata?**", async (route) => {
      const targetUrl = new URL(route.request().url()).searchParams.get("url");
      if (targetUrl === secondUrl) await secondMetadata;
      const iconUrl = targetUrl === firstUrl
        ? firstIconUrl
        : targetUrl === secondUrl
          ? secondIconUrl
          : null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: targetUrl,
          siteName: null,
          pageTitle: null,
          iconUrl,
        }),
      });
    });
    await page.route("**/api/website-metadata/icon?**", async (route) => {
      const targetUrl = new URL(route.request().url()).searchParams.get("url");
      const fill = targetUrl?.startsWith(firstUrl) ? "#16a34a" : targetUrl?.startsWith(secondUrl) ? "#2563eb" : null;
      if (!fill) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${fill}"/></svg>`,
      });
    });

    await page.goto(`/${organization.issuePrefix}/ui-lab`);
    await page.getByRole("button", { name: /Common Components/ }).click();

    const fixture = page.getByTestId("ui-lab-website-link-rerender");
    const dynamicLink = fixture.locator("a.rudder-website-link");
    await expect(dynamicLink).toHaveAttribute("href", firstUrl);
    await expect(dynamicLink.locator("img.rudder-website-link-logo")).toHaveAttribute("src", firstIconUrl);
    await expect(dynamicLink.locator("img.rudder-website-link-logo")).toHaveAttribute("data-website-icon", "metadata");
    const firstIconBox = await dynamicLink.locator(".rudder-website-link-icon").boundingBox();
    expect(firstIconBox).not.toBeNull();

    const swapButton = fixture.getByRole("button", { name: "Swap website link" });
    await swapButton.click();
    await expect(dynamicLink).toHaveAttribute("href", secondUrl);
    await expect(dynamicLink.locator('[data-website-icon="generic"]')).toBeVisible();
    await expect(dynamicLink.locator("img[src]")).toHaveCount(0);
    const loadingIconBox = await dynamicLink.locator(".rudder-website-link-icon").boundingBox();
    expect(loadingIconBox).not.toBeNull();
    expect(Math.abs((loadingIconBox?.width ?? 0) - (firstIconBox?.width ?? 0))).toBeLessThanOrEqual(0.5);
    expect(Math.abs((loadingIconBox?.height ?? 0) - (firstIconBox?.height ?? 0))).toBeLessThanOrEqual(0.5);

    releaseSecondMetadata?.();
    await expect(dynamicLink.locator("img.rudder-website-link-logo")).toHaveAttribute("src", secondIconUrl);
    await expect(dynamicLink.locator("img.rudder-website-link-logo")).toHaveAttribute("data-website-icon", "metadata");
    await expect(dynamicLink.locator('[data-website-icon="generic"]')).toHaveCount(0);

    await context.route(`${secondUrl}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Keyboard target</title>",
      });
    });
    await swapButton.focus();
    await page.keyboard.press("Tab");
    await expect(dynamicLink).toBeFocused();
    const popupPromise = page.waitForEvent("popup");
    await page.keyboard.press("Enter");
    const popup = await popupPromise;
    await expect.poll(() => popup.url()).toBe(secondUrl);
    await popup.close();

    await page.screenshot({ path: testInfo.outputPath("website-link-rerender-keyboard.png"), fullPage: false });
    await expect(dynamicLink).toHaveAttribute("target", "_blank");
    await expect(dynamicLink.locator(".rudder-website-link-icon")).toHaveAttribute("aria-hidden", "true");
    expect(context.pages().length).toBe(1);
  });

  test("shows a hover copy action on command terminal transcript details", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const organization = await createUiLabOrganization(page);

    await page.goto(`/${organization.issuePrefix}/tests/ux/runs`);
    await expect(page.getByText("Run transcript UX lab")).toBeVisible();
    await expect(page.getByText("Run Transcript Fixtures")).toBeVisible();

    await page.getByRole("button", { name: "Expand tool activity group 1" }).click();
    const docGoalCommand = page.getByRole("button", { name: /Expand command details:.*GOAL\.md/ });
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

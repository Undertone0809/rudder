import { expect, test, type Locator, type Page } from "@playwright/test";

const AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAvElEQVR4nOXOMQEAIAzAsCqZTiTiisnIwZE/nbnvZ+mAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YC2eEHSLFdn2uQAAAAASUVORK5CYII=",
  "base64",
);

async function closeMobileSidebar(page: Page) {
  const closeSidebar = page.locator('button[aria-label="Close sidebar"]').first();
  if (await closeSidebar.isVisible()) {
    await closeSidebar.click();
  }
  await expect(closeSidebar).toBeHidden();
}

async function expectLocatorWithinViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

async function expectLocatorUnobscured(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(async () => {
    return locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const topElement = document.elementFromPoint(x, y);
      return Boolean(topElement && (element === topElement || element.contains(topElement)));
    });
  }).toBe(true);
}

async function expectAvatarAndNameLayout(page: Page, avatar: Locator, name: Locator, minGap: number) {
  await expectLocatorWithinViewport(page, avatar);
  await expectLocatorWithinViewport(page, name);
  await expectLocatorUnobscured(avatar);
  await expectLocatorUnobscured(name);

  const avatarBox = await avatar.boundingBox();
  const nameBox = await name.boundingBox();
  expect(avatarBox).not.toBeNull();
  expect(nameBox).not.toBeNull();
  expect(nameBox!.x - (avatarBox!.x + avatarBox!.width)).toBeGreaterThanOrEqual(minGap);
  expect(nameBox!.x).toBeGreaterThan(avatarBox!.x + avatarBox!.width);
}

test.describe("Agent avatar", () => {
  test("uses a DiceBear avatar by default and lets users upload a compressed image avatar", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Avatar-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Avatar Agent",
        role: "engineer",
        title: "Visual Identity",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();
    expect(agent.icon).toMatch(/^dicebear:notionists:/);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/dashboard`);
    await expect(page.getByRole("heading", { name: "Avatar Agent", exact: true })).toBeVisible();

    const avatarButton = page.getByRole("button", { name: "Change agent avatar" });
    const generatedAvatarImage = avatarButton.locator('img[src^="data:image/svg+xml"]').first();
    await expect(generatedAvatarImage).toBeVisible();

    await avatarButton.click();
    await expect(page.getByRole("textbox", { name: "Emoji" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Random" })).toBeVisible();

    const uploadResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/agents/${agent.id}/avatar`),
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: AVATAR_PNG,
    });
    const uploaded = await uploadResponse;
    expect(uploaded.ok()).toBe(true);

    const refreshedRes = await page.request.get(`/api/agents/${agent.id}?orgId=${organization.id}`);
    expect(refreshedRes.ok()).toBe(true);
    const refreshedAgent = await refreshedRes.json();
    expect(refreshedAgent.icon).toMatch(/^asset:/);
    const detailAvatarImage = avatarButton.locator('img[src*="/api/assets/"]');
    await expect(detailAvatarImage).toHaveAttribute("src", /\/api\/assets\/.+\/content/);
    await expect(detailAvatarImage).toHaveCSS("object-fit", "cover");
    await expect(detailAvatarImage).toHaveCSS("width", "48px");
    await expect(detailAvatarImage).toHaveCSS("height", "48px");
    await expect(detailAvatarImage.locator('xpath=ancestor::button[contains(@class, "bg-accent") or contains(@class, "rounded-lg")]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: "/tmp/rudder-agent-detail-image-avatar-desktop.png", fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/dashboard`);
    await closeMobileSidebar(page);
    const mobileDetailName = page.getByRole("heading", { name: "Avatar Agent", exact: true });
    await expect(detailAvatarImage).toBeVisible();
    await expect(detailAvatarImage).toHaveCSS("object-fit", "cover");
    await expect(detailAvatarImage).toHaveCSS("width", "48px");
    await expect(detailAvatarImage).toHaveCSS("height", "48px");
    await expect(detailAvatarImage.locator('xpath=ancestor::button[contains(@class, "bg-accent") or contains(@class, "rounded-lg")]')).toHaveCount(0);
    await expectAvatarAndNameLayout(page, detailAvatarImage, mobileDetailName, 8);
    await page.screenshot({ path: "/tmp/rudder-agent-detail-image-avatar-mobile.png", fullPage: true });

    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(`/${organization.issuePrefix}/org`);
    const orgCard = page.locator("[data-org-card]").filter({ hasText: "Avatar Agent" }).first();
    await expect(orgCard).toBeVisible();
    const orgAvatarImage = orgCard.locator('img[src*="/api/assets/"]').first();
    const orgAgentName = orgCard.getByText("Avatar Agent", { exact: true });
    await expect(orgAvatarImage).toBeVisible();
    await expect(orgAvatarImage).toHaveCSS("object-fit", "cover");
    await expect(orgAvatarImage).toHaveCSS("width", "36px");
    await expect(orgAvatarImage).toHaveCSS("height", "36px");
    await expect(orgAvatarImage.locator('xpath=parent::*[contains(@class, "bg-muted")]')).toHaveCount(0);
    await page.screenshot({ path: "/tmp/rudder-org-chart-image-avatar-desktop.png", fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${organization.issuePrefix}/org`);
    await closeMobileSidebar(page);
    await expect(orgCard).toBeVisible();
    await expect(orgAvatarImage).toBeVisible();
    await expect(orgAvatarImage).toHaveCSS("object-fit", "cover");
    await expect(orgAvatarImage).toHaveCSS("width", "36px");
    await expect(orgAvatarImage).toHaveCSS("height", "36px");
    await expect(orgAvatarImage.locator('xpath=parent::*[contains(@class, "bg-muted")]')).toHaveCount(0);
    await expectAvatarAndNameLayout(page, orgAvatarImage, orgAgentName, 6);
    await orgCard.screenshot({ path: "/tmp/rudder-org-chart-image-avatar-mobile-card.png" });
    await page.screenshot({ path: "/tmp/rudder-org-chart-image-avatar-mobile.png", fullPage: true });
  });
});

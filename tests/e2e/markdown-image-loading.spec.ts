import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./support/e2e-env";

test.use({ serviceWorkers: "block" });

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

const VISIBLE_TEST_PNG = readFileSync(new URL("../../ui/public/favicon-32x32.png", import.meta.url));

type Organization = {
  id: string;
  issuePrefix: string;
};

type ImageAsset = {
  contentPath: string;
};

async function createOrganization(page: Page, name: string) {
  const response = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as Organization;
}

async function createImageAsset(page: Page, organizationId: string, name: string) {
  const response = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organizationId}/assets/images`, {
    multipart: {
      namespace: "markdown-image-loading",
      file: {
        name,
        mimeType: "image/png",
        buffer: VISIBLE_TEST_PNG,
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as ImageAsset;
}

async function selectOrganization(page: Page, organizationId: string) {
  await page.goto(E2E_BASE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate((selectedOrganizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrganizationId);
  }, organizationId);
}

async function writeWorkspaceMarkdown(
  page: Page,
  organizationId: string,
  filePath: string,
  content: string,
) {
  const response = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organizationId}/workspace/file`, {
    data: { filePath, content },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function assertMarkdownImageStates(
  page: Page,
  imagePaths: { loading: string; retry: string },
  imageNames: { loading: string; retry: string },
  openUrl: string,
) {
  let releaseLoadingRequest: (() => void) | null = null;
  const loadingGate = new Promise<void>((resolve) => {
    releaseLoadingRequest = resolve;
  });
  let retryAttempts = 0;
  let retryAllowed = false;
  let releaseRetryRequest: (() => void) | null = null;
  let retryRequestGate = Promise.resolve();
  const loadingUrl = new URL(imagePaths.loading, E2E_BASE_URL).toString();
  const retryUrl = new URL(imagePaths.retry, E2E_BASE_URL).toString();

  await page.route(loadingUrl, async (route) => {
    await loadingGate;
    await route.continue();
  });
  await page.route(retryUrl, async (route) => {
    retryAttempts += 1;
    if (!retryAllowed) {
      await route.fulfill({
        body: "not-a-decodable-image",
        contentType: "image/png",
        status: 200,
      });
      return;
    }
    await retryRequestGate;
    await route.continue();
  });

  try {
    await page.goto(openUrl, { waitUntil: "domcontentloaded" });

    const loadingTrigger = page.locator(
      `button.rudder-inspectable-image-trigger[aria-label$="${imageNames.loading}"]`,
    );
    const retryTrigger = page.locator(
      `button.rudder-inspectable-image-trigger[aria-label$="${imageNames.retry}"]`,
    );
    await expect(loadingTrigger).toHaveAttribute("data-image-state", "loading");
    await expect(loadingTrigger.getByTestId("inspectable-image-skeleton")).toBeVisible();
    await expect(retryTrigger.getByRole("img", { name: `${imageNames.retry} unavailable` })).toBeVisible();
    await expect(retryTrigger).toHaveAttribute("data-image-state", "error");
    const retryAttemptsBeforeExplicitRetry = retryAttempts;
    retryRequestGate = new Promise<void>((resolve) => {
      releaseRetryRequest = resolve;
    });
    retryAllowed = true;

    releaseLoadingRequest?.();
    releaseLoadingRequest = null;
    await expect(loadingTrigger).toHaveAttribute("data-image-state", "loaded");
    await expect(loadingTrigger.getByTestId("inspectable-image-skeleton")).toHaveCount(0);
    await expect(loadingTrigger.locator(`img[alt="${imageNames.loading}"]`)).toBeVisible();

    const retryButton = page.locator(
      `button.rudder-inspectable-image-trigger[aria-label$="${imageNames.retry}"]`,
    );
    await retryButton.click();
    await expect(retryButton).toHaveAttribute("data-image-state", "loading");
    await expect(retryButton.getByTestId("inspectable-image-skeleton")).toBeVisible();
    releaseRetryRequest?.();
    releaseRetryRequest = null;
    await expect(retryButton).toHaveAttribute("data-image-state", "loaded");
    await expect(retryButton.locator(`img[alt="${imageNames.retry}"]`)).toBeVisible();
    expect(retryAttempts).toBeGreaterThan(retryAttemptsBeforeExplicitRetry);
  } finally {
    releaseLoadingRequest?.();
    releaseRetryRequest?.();
    await page.unroute(loadingUrl);
    await page.unroute(retryUrl);
  }
}

async function issueDescriptionWithImages(page: Page, organization: Organization) {
  const loadingAsset = await createImageAsset(page, organization.id, "issue-loading.png");
  const retryAsset = await createImageAsset(page, organization.id, "issue-retry.png");
  const response = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Markdown image states",
      description: [
        "# Image evidence",
        "",
        `![Issue loading](${loadingAsset.contentPath})`,
        "",
        `![Issue retry](${retryAsset.contentPath})`,
      ].join("\n"),
      status: "todo",
      priority: "medium",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const issue = await response.json() as {
    description: string | null;
    id: string;
    identifier: string | null;
  };
  const imagePaths = [...(issue.description ?? "").matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)]
    .map((match) => match[1])
    .filter((path): path is string => Boolean(path));
  expect(imagePaths).toHaveLength(2);
  return {
    identifier: issue.identifier ?? issue.id,
    imagePaths: { loading: imagePaths[0]!, retry: imagePaths[1]! },
  };
}

test("Issue detail keeps Markdown image loading, success, and retry states visible", async ({ page }) => {
  const organization = await createOrganization(page, "Issue-Markdown-Image-Loading");
  const issue = await issueDescriptionWithImages(page, organization);
  await selectOrganization(page, organization.id);

  await assertMarkdownImageStates(
    page,
    issue.imagePaths,
    { loading: "Issue loading", retry: "Issue retry" },
    `${E2E_BASE_URL}/${organization.issuePrefix}/issues/${issue.identifier}`,
  );
});

test("Library Markdown keeps image loading, success, and retry states visible", async ({ page }) => {
  const organization = await createOrganization(page, "Library-Markdown-Image-Loading");
  const loadingAsset = await createImageAsset(page, organization.id, "library-loading.png");
  const retryAsset = await createImageAsset(page, organization.id, "library-retry.png");
  const filePath = "docs/image-loading.md";
  await writeWorkspaceMarkdown(
    page,
    organization.id,
    filePath,
    [
      "# Library image evidence",
      "",
      `![Library loading](${loadingAsset.contentPath})`,
      "",
      `![Library retry](${retryAsset.contentPath})`,
    ].join("\n"),
  );
  await selectOrganization(page, organization.id);

  await assertMarkdownImageStates(
    page,
    { loading: loadingAsset.contentPath, retry: retryAsset.contentPath },
    { loading: "Library loading", retry: "Library retry" },
    `${E2E_BASE_URL}/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`,
  );
});

test("Chat Markdown keeps image loading and retry states contained on a narrow viewport", async ({ page }) => {
  test.setTimeout(120_000);
  const organization = await createOrganization(page, "Chat-Markdown-Image-Loading");
  const agent = await createE2EChatAgent(page.request, organization.id, { name: "Image Loading Agent" });
  const loadingAsset = await createImageAsset(page, organization.id, "chat-loading.png");
  const retryAsset = await createImageAsset(page, organization.id, "chat-retry.png");
  const response = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Chat Markdown image states",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: {
        body: [
          "Review these images:",
          "",
          `![Chat loading](${loadingAsset.contentPath})`,
          "",
          `![Chat retry](${retryAsset.contentPath})`,
        ].join("\n"),
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const chat = await response.json() as { id: string };
  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: [
      "Review these images:",
      "",
      `![Chat loading](${loadingAsset.contentPath})`,
      "",
      `![Chat retry](${retryAsset.contentPath})`,
    ].join("\n"),
    structuredPayload: null,
    replyingAgentId: agent.id,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });
  await selectOrganization(page, organization.id);
  await page.setViewportSize({ width: 390, height: 844 });

  await assertMarkdownImageStates(
    page,
    { loading: loadingAsset.contentPath, retry: retryAsset.contentPath },
    { loading: "Chat loading", retry: "Chat retry" },
    `${E2E_BASE_URL}/${organization.issuePrefix}/messenger/chat/${chat.id}`,
  );

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  for (const name of ["Chat loading", "Chat retry"]) {
    const box = await page.locator(`button.rudder-inspectable-image-trigger[aria-label$="${name}"]`).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await page.screenshot({ path: "/tmp/r6z-162-chat-markdown-mobile.png", fullPage: true });
});

import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.use({ serviceWorkers: "block" });

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5p1sAAAAASUVORK5CYII=",
  "base64",
);

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
        buffer: ONE_BY_ONE_PNG,
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

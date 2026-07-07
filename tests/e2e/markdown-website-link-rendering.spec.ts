import { expect, test } from "@playwright/test";

test("renders website markdown links as inline icon-leading text that wraps", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Markdown-Website-Link-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const url = "https://github.com/Undertone0809/rudder/releases?page=5";
  const requestedUrls: string[] = [];
  page.on("request", (request) => {
    requestedUrls.push(request.url());
  });
  await page.route("**/api/website-metadata?**", async (route) => {
    const requestUrl = new URL(route.request().url());
    expect(requestUrl.searchParams.get("url")).toBe(url);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url,
        siteName: "GitHub",
        iconUrl: "/api/website-metadata/icon?url=https%3A%2F%2Fgithub.githubassets.com%2Ffavicons%2Ffavicon.png",
      }),
    });
  });
  await page.route("**/api/website-metadata/icon?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><rect width=\"16\" height=\"16\" rx=\"3\" fill=\"#24292f\"/></svg>",
    });
  });
  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Website markdown link render",
      description: `Track ${url}`,
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier?: string | null };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 420, height: 760 });
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const link = page.locator("a.rudder-website-link").filter({ hasText: url }).first();
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", url);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noreferrer noopener");
  const icon = link.locator("img.rudder-website-link-logo").first();
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAttribute("data-website-icon", "metadata");
  await expect(icon).toHaveAttribute("src", "/api/website-metadata/icon?url=https%3A%2F%2Fgithub.githubassets.com%2Ffavicons%2Ffavicon.png");
  await expect(link.locator(".rudder-link-chip-domain")).toHaveCount(0);

  const render = await link.evaluate((element) => {
    const label = element.querySelector(".rudder-website-link-label");
    const markdown = element.closest(".rudder-markdown") ?? element.parentElement;
    const style = window.getComputedStyle(element);
    const icon = element.querySelector(".rudder-website-link-icon");
    const labelStyle = label ? window.getComputedStyle(label) : null;
    const labelRects = label
      ? Array.from(label.getClientRects()).map((line) => ({
        right: line.right,
      }))
      : [];
    const markdownRect = markdown?.getBoundingClientRect();
    const iconRect = icon?.getBoundingClientRect();
    const firstLabelRect = label?.getClientRects()[0];
    const maxLineRight = labelRects.reduce((max, line) => Math.max(max, line.right), 0);
    return {
      backgroundImage: style.backgroundImage,
      borderTopWidth: style.borderTopWidth,
      borderRadius: style.borderRadius,
      display: style.display,
      lineCount: labelRects.length,
      overflowsMarkdown: markdownRect ? maxLineRight > markdownRect.right + 1 : true,
      paddingInlineEnd: style.paddingInlineEnd,
      paddingInlineStart: style.paddingInlineStart,
      labelOverflowWrap: labelStyle?.overflowWrap,
      iconHeight: iconRect?.height,
      iconVerticalCenterDelta: iconRect && firstLabelRect
        ? Math.abs((iconRect.top + iconRect.height / 2) - (firstLabelRect.top + firstLabelRect.height / 2))
        : null,
    };
  });

  expect(render).toMatchObject({
    backgroundImage: "none",
    borderTopWidth: "0px",
    borderRadius: "0px",
    display: "inline",
    labelOverflowWrap: "anywhere",
    overflowsMarkdown: false,
    paddingInlineEnd: "0px",
    paddingInlineStart: "0px",
  });
  expect(render.iconHeight).toBeGreaterThan(10);
  expect(render.iconHeight).toBeLessThan(18);
  expect(render.iconVerticalCenterDelta).not.toBeNull();
  expect(render.iconVerticalCenterDelta).toBeLessThanOrEqual(3);
  expect(render.lineCount).toBeGreaterThan(1);
  expect(requestedUrls.some((requestUrl) => requestUrl.startsWith("https://icons.duckduckgo.com/"))).toBe(false);
});

test("does not fetch provider or origin favicons for internal website markdown links", async ({ page }) => {
  const requestedUrls: string[] = [];
  page.on("request", (request) => {
    requestedUrls.push(request.url());
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Markdown-Internal-Link-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const url = "http://127.0.0.1:8080/post";
  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Internal website markdown link render",
      description: `Track ${url}`,
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier?: string | null };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const link = page.locator("a.rudder-website-link").filter({ hasText: url }).first();
  await expect(link).toBeVisible();
  await expect(link.locator("img.rudder-website-link-logo")).toHaveCount(0);
  await expect(link.locator('[data-website-icon="generic"]')).toBeVisible();

  expect(requestedUrls.some((requestUrl) => requestUrl.startsWith("https://icons.duckduckgo.com/"))).toBe(false);
  expect(requestedUrls.some((requestUrl) => requestUrl.startsWith("http://127.0.0.1:8080/"))).toBe(false);
});

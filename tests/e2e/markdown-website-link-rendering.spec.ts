import { expect, test } from "@playwright/test";

test("renders website markdown links as inline icon-leading text that wraps", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Markdown-Website-Link-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const url = "https://example.org/teams/platform/release-notes/very-long-regression-report?page=5&section=metadata-icon-rendering";
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
        siteName: "Example",
        iconUrl: "/api/website-metadata/icon?url=https%3A%2F%2Fstatic.example.org%2Ffavicons%2Ffavicon.png",
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
  await expect(icon).toHaveAttribute("src", "/api/website-metadata/icon?url=https%3A%2F%2Fstatic.example.org%2Ffavicons%2Ffavicon.png");
  await expect(link.locator(".rudder-link-chip-domain")).toHaveCount(0);

  const render = await link.evaluate((element) => {
    const label = element.querySelector(".rudder-website-link-label");
    const markdown = element.closest(".rudder-markdown") ?? element.parentElement;
    const style = window.getComputedStyle(element);
    const icon = element.querySelector(".rudder-website-link-icon");
    const iconStyle = icon ? window.getComputedStyle(icon) : null;
    const labelStyle = label ? window.getComputedStyle(label) : null;
    const firstTextNode = label?.firstChild && label.firstChild.nodeType === Node.TEXT_NODE
      ? label.firstChild
      : null;
    const firstTextRange = firstTextNode ? document.createRange() : null;
    if (firstTextRange && firstTextNode?.textContent) {
      firstTextRange.setStart(firstTextNode, 0);
      firstTextRange.setEnd(firstTextNode, firstTextNode.textContent.length);
    }
    const labelRects = firstTextRange
      ? Array.from(firstTextRange.getClientRects()).map((line) => ({
        right: line.right,
      }))
      : [];
    const firstTextLineRect = firstTextRange?.getClientRects()[0] ?? null;
    const markdownRect = markdown?.getBoundingClientRect();
    const iconRect = icon?.getBoundingClientRect();
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
      iconTopPx: iconStyle ? Number.parseFloat(iconStyle.top) : null,
      labelOverflowWrap: labelStyle?.overflowWrap,
      iconHeight: iconRect?.height,
      iconVerticalCenterDelta: iconRect && firstTextLineRect
        ? Math.abs((iconRect.top + iconRect.height / 2) - (firstTextLineRect.top + firstTextLineRect.height / 2))
        : null,
    };
  });

  expect(render).toMatchObject({
    backgroundImage: "none",
    borderTopWidth: "0px",
    borderRadius: "0px",
    display: "inline-flex",
    labelOverflowWrap: "anywhere",
    overflowsMarkdown: false,
    paddingInlineEnd: "0px",
    paddingInlineStart: "0px",
  });
  expect(render.iconHeight).toBeGreaterThan(10);
  expect(render.iconHeight).toBeLessThan(18);
  expect(render.iconTopPx).not.toBeNull();
  expect(render.iconTopPx).toBeGreaterThan(0);
  expect(render.iconTopPx).toBeLessThan(1.2);
  expect(render.iconVerticalCenterDelta).not.toBeNull();
  expect(render.iconVerticalCenterDelta).toBeLessThanOrEqual(3);
  expect(render.lineCount).toBeGreaterThan(1);
  expect(requestedUrls.some((requestUrl) => requestUrl.startsWith("https://icons.duckduckgo.com/"))).toBe(false);
});

test("renders known website icons without fetching metadata", async ({ page }) => {
  const requestedUrls: string[] = [];
  page.on("request", (request) => {
    requestedUrls.push(request.url());
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Markdown-Known-Website-Icon-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const urls = [
    "https://x.com/my_knn_totoro/status/2068910037238772102",
    "https://docs.feishu.cn/docx/example",
    "https://rudderhq.dev/docs",
    "https://learn.chatgpt.com/docs/sandboxing/auto-review",
    "https://platform.openai.com/docs",
    "https://docs.anthropic.com/en/docs/overview",
    "https://www.reddit.com/r/LocalLLaMA/",
    "https://engineering.medium.com/post",
    "https://news.ycombinator.com/item?id=1",
    "https://linux.do/t/topic/1",
  ];
  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Known website icon render",
      description: urls.map((url) => `Track ${url}`).join("\n\n"),
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

  for (const url of urls) {
    const link = page.locator("a.rudder-website-link").filter({ hasText: url }).first();
    await expect(link).toBeVisible();
    const icon = link.locator("img.rudder-website-link-logo").first();
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute("data-website-icon", "metadata");
    await expect(icon).toHaveAttribute("src", /^data:image\/(?:x-icon|png|svg\+xml);base64,/u);
    await expect(icon).not.toHaveAttribute("src", /^data:image\/svg\+xml,/u);
    await expect(link.locator('[data-website-icon="generic"]')).toHaveCount(0);
  }

  expect(requestedUrls.some((requestUrl) => requestUrl.includes("/api/website-metadata?"))).toBe(false);
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

test("resolves real website icons through the running metadata service", async ({ page }) => {
  const requestedUrls: string[] = [];
  page.on("request", (request) => {
    requestedUrls.push(request.url());
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Markdown-Real-Website-Icons-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const links = {
    github: "https://github.com/Undertone0809/rudder",
    nist: "https://www.nist.gov/itl/ai-risk-management-framework",
    hbr: "https://hbr.org/2007/09/performing-a-project-premortem",
    pdf: "https://home.army.mil/wood/6115/8222/0759/RedTeamHB.pdf",
    internal: "http://127.0.0.1:8080/post",
  };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Real website icon rendering",
      description: [
        `GitHub ${links.github}`,
        `NIST ${links.nist}`,
        `HBR ${links.hbr}`,
        `PDF ${links.pdf}`,
        `Internal ${links.internal}`,
      ].join("\n\n"),
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

  for (const url of [links.github, links.nist]) {
    const link = page.locator("a.rudder-website-link").filter({ hasText: url }).first();
    await expect(link).toBeVisible();
    await expect(link.locator("img.rudder-website-link-logo")).toBeVisible({ timeout: 15_000 });
    await expect(link.locator(".rudder-website-link-icon")).toHaveAttribute("data-website-icon", "metadata");
  }

  await expect(page.locator("a.rudder-website-link").filter({ hasText: links.hbr }).first()).toBeVisible();

  const internalLink = page.locator("a.rudder-website-link").filter({ hasText: links.internal }).first();
  await expect(internalLink).toBeVisible();
  await expect(internalLink.locator("img.rudder-website-link-logo")).toHaveCount(0);
  await expect(internalLink.locator('[data-website-icon="generic"]')).toBeVisible();

  const pdfLink = page.locator("a.rudder-website-link").filter({ hasText: links.pdf }).first();
  await expect(pdfLink).toBeVisible();

  const render = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a.rudder-website-link")).map((link) => {
      const icon = link.querySelector(".rudder-website-link-icon");
      const img = link.querySelector("img.rudder-website-link-logo");
      const label = link.querySelector(".rudder-website-link-label");
      const iconRect = icon?.getBoundingClientRect();
      const labelRect = label?.getBoundingClientRect();
      return {
        href: link.getAttribute("href"),
        iconKind: icon?.getAttribute("data-website-icon") ?? null,
        imgSrc: img?.getAttribute("src") ?? null,
        centerDelta: iconRect && labelRect
          ? Math.abs((iconRect.top + iconRect.height / 2) - (labelRect.top + labelRect.height / 2))
          : null,
      };
    });
  });

  const publicIconRows = render.filter((row) => [links.github, links.nist].includes(row.href ?? ""));
  expect(publicIconRows).toHaveLength(2);
  expect(publicIconRows.every((row) => row.iconKind === "metadata")).toBe(true);
  expect(publicIconRows.find((row) => row.href === links.github)?.imgSrc).toMatch(/^data:image\/(?:x-icon|png|svg\+xml);base64,/u);
  expect(publicIconRows.find((row) => row.href === links.github)?.imgSrc).not.toMatch(/^data:image\/svg\+xml,/u);
  expect(publicIconRows
    .filter((row) => row.href !== links.github)
    .every((row) => row.imgSrc?.startsWith("/api/website-metadata/icon?"))).toBe(true);
  expect(publicIconRows.every((row) => row.centerDelta !== null && row.centerDelta <= 3)).toBe(true);
  expect(requestedUrls.some((requestUrl) => requestUrl.startsWith("https://icons.duckduckgo.com/"))).toBe(false);
  expect(requestedUrls.some((requestUrl) => requestUrl.startsWith(links.internal))).toBe(false);
});

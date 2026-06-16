import { expect, test } from "@playwright/test";

test("renders website markdown links as inline icon-leading text that wraps", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Markdown-Website-Link-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const url = "https://github.com/Undertone0809/rudder/releases?page=5";
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
  await expect(link.locator('[data-website-icon="github"]')).toBeVisible();
  await expect(link.locator(".rudder-link-chip-domain")).toHaveCount(0);

  const render = await link.evaluate((element) => {
    const label = element.querySelector(".rudder-website-link-label");
    const markdown = element.closest(".rudder-markdown") ?? element.parentElement;
    const style = window.getComputedStyle(element);
    const labelStyle = label ? window.getComputedStyle(label) : null;
    const labelRects = label
      ? Array.from(label.getClientRects()).map((line) => ({
        right: line.right,
      }))
      : [];
    const markdownRect = markdown?.getBoundingClientRect();
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
  expect(render.lineCount).toBeGreaterThan(1);
});

import { expect, test } from "@playwright/test";

test("bounds long special links in issue comments and preserves their full labels", async ({ page }, testInfo) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Markdown-Special-Link-Overflow-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const longIssueTitle = "A very long issue title that should stay readable in the tooltip while the inline token remains bounded";
  const targetIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: longIssueTitle,
      description: "Target issue for the overflow regression.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(targetIssueRes.ok(), await targetIssueRes.text()).toBe(true);
  const targetIssue = await targetIssueRes.json() as { id: string; identifier: string | null };
  const expectedIssueLabel = targetIssue.identifier ? `${targetIssue.identifier} ${longIssueTitle}` : longIssueTitle;

  const hostIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue comment special link overflow",
      description: "The comment below contains production-shaped special links.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(hostIssueRes.ok(), await hostIssueRes.text()).toBe(true);
  const hostIssue = await hostIssueRes.json() as { id: string; identifier: string | null };

  const longChatLabel = "我先读取 Rudder 的可用 MCP 工具，并定位这个 issue 的上下文、当前状态流转和相关历史，再从 Agent 视角梳理用户旅程与可行优化方案";
  const longWebsiteLabel = "A very long website label that should stop growing before it pushes the comment wider";
  const longFileLabel = "a-very-long-local-file-name-that-should-stop-growing-before-it-pushes-the-comment-wider.tsx";
  const longSkillLabel = "a-very-long-skill-reference-label-that-should-stop-growing";
  const commentBody = [
    "Before the special links.",
    `[${longChatLabel}](chat://overflow-chat)`,
    `[${longIssueTitle}](issue://${targetIssue.id})`,
    `[${longWebsiteLabel}](http://127.0.0.1:8080/long-document)`,
    `[${longFileLabel}](/tmp/${longFileLabel})`,
    `[${longSkillLabel}](skill://local/%2Fworkspace%2F.agents%2Fskills%2Flong-skill?ref=${longSkillLabel})`,
    "After the special links.",
  ].join("\n\n");
  const commentRes = await page.request.post(`/api/issues/${hostIssue.id}/comments`, {
    data: { body: commentBody },
  });
  expect(commentRes.ok(), await commentRes.text()).toBe(true);
  const comment = await commentRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 420, height: 840 });
  await page.goto(`/${organization.issuePrefix}/issues/${hostIssue.identifier ?? hostIssue.id}`);

  const commentBlock = page.locator(`#comment-${comment.id}`);
  await expect(commentBlock).toBeVisible();
  const chatLink = commentBlock.locator('a[data-mention-kind="chat"]').first();
  const issueLink = commentBlock.locator('a[data-mention-kind="issue"]').first();
  const websiteLink = commentBlock.locator("a.rudder-website-link").first();
  const fileLink = commentBlock.locator("a.rudder-local-file-link").first();
  const skillToken = commentBlock.locator('[data-skill-token="true"]').first();
  await expect(chatLink).toBeVisible();
  await expect(issueLink).toBeVisible();
  await expect(websiteLink).toBeVisible();
  await expect(fileLink).toBeVisible();
  await expect(skillToken).toBeVisible();
  await expect(chatLink).toHaveAttribute("title", longChatLabel);
  await expect(issueLink).toHaveAttribute("title", expectedIssueLabel);
  await expect(websiteLink).toHaveAttribute("title", longWebsiteLabel);
  await expect(fileLink).toHaveAttribute("title", longFileLabel);
  await expect(skillToken).toHaveAttribute("title", longSkillLabel);
  await expect(commentBlock).toContainText("Before the special links.");
  await expect(commentBlock).toContainText("After the special links.");

  const render = await commentBlock.evaluate((root) => {
    const surface = root.querySelector<HTMLElement>(".rudder-markdown");
    const surfaceRect = surface?.getBoundingClientRect();
    const links = Array.from(root.querySelectorAll<HTMLElement>(
      'a[data-mention-kind="chat"], a[data-mention-kind="issue"], a.rudder-website-link, a.rudder-local-file-link, [data-skill-token="true"]',
    )).map((link) => {
      const rect = link.getBoundingClientRect();
      const label = link.querySelector<HTMLElement>(".rudder-inline-token-label");
      return {
        width: rect.width,
        right: rect.right,
        labelWidth: label?.getBoundingClientRect().width ?? 0,
        labelClientWidth: label?.clientWidth ?? 0,
        labelScrollWidth: label?.scrollWidth ?? 0,
        maxWidth: getComputedStyle(link).maxWidth,
        textOverflow: label ? getComputedStyle(label).textOverflow : "",
        whiteSpace: label ? getComputedStyle(label).whiteSpace : "",
      };
    });
    return {
      surfaceClientWidth: surface?.clientWidth ?? 0,
      surfaceScrollWidth: surface?.scrollWidth ?? Number.POSITIVE_INFINITY,
      surfaceRight: surfaceRect?.right ?? Number.NEGATIVE_INFINITY,
      links,
    };
  });

  expect(render.surfaceScrollWidth).toBeLessThanOrEqual(render.surfaceClientWidth + 2);
  expect(render.links).toHaveLength(5);
  for (const link of render.links) {
    expect(link.width).toBeLessThanOrEqual(Math.min(480, render.surfaceClientWidth) + 1);
    expect(link.right).toBeLessThanOrEqual(render.surfaceRight + 1);
    expect(link.labelWidth).toBeLessThanOrEqual(link.width + 1);
    expect(link.labelScrollWidth).toBeGreaterThan(link.labelClientWidth);
    expect(link.maxWidth).toMatch(/^(?:min\(480px, 100%\)|100%)$/u);
    expect(link.textOverflow).toBe("ellipsis");
    expect(link.whiteSpace).toBe("nowrap");
  }

  await page.screenshot({
    path: testInfo.outputPath("markdown-special-link-overflow.png"),
    fullPage: true,
  });
});

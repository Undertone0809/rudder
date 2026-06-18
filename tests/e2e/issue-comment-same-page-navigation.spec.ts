import { expect, test } from "@playwright/test";

test("same-issue comment links scroll in place without reloading the issue page", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Scroll-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Same issue comment navigation",
      description: "Current issue comment links should scroll without reloading.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };
  const routeRef = issue.identifier ?? issue.id;

  const targetCommentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: { body: "Target comment for same-page navigation." },
  });
  expect(targetCommentRes.ok()).toBe(true);
  const targetComment = await targetCommentRes.json() as { id: string };

  const linkHref = `issue://${issue.id}?c=${targetComment.id}`;
  const linkCommentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: {
      body: `[Issue comment ${targetComment.id.slice(0, 8)}](${linkHref})`,
    },
  });
  expect(linkCommentRes.ok()).toBe(true);
  const linkComment = await linkCommentRes.json() as { id: string };

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/issues/${routeRef}`);

  const targetCommentBlock = page.locator(`#comment-${targetComment.id}`);
  const linkCommentBlock = page.locator(`#comment-${linkComment.id}`);
  await expect(targetCommentBlock).toBeVisible();
  await expect(linkCommentBlock).toBeVisible();

  const commentLink = linkCommentBlock.getByRole("link", { name: `Issue comment ${targetComment.id.slice(0, 8)}` });
  await expect(commentLink).toHaveAttribute(
    "href",
    `/${organization.issuePrefix}/issues/${issue.id}#comment-${targetComment.id}`,
  );

  await page.evaluate(() => {
    (window as typeof window & { __rudderSameIssueCommentNavigation?: string }).__rudderSameIssueCommentNavigation = "kept";
  });
  await commentLink.click();

  await expect(page).toHaveURL(
    `${new URL(page.url()).origin}/${organization.issuePrefix}/messenger/issues/${routeRef}#comment-${targetComment.id}`,
  );
  await expect.poll(async () => page.evaluate(() => (
    (window as typeof window & { __rudderSameIssueCommentNavigation?: string }).__rudderSameIssueCommentNavigation
  ))).toBe("kept");
  await expect(targetCommentBlock).toHaveClass(/bg-primary\/5/);
});

test("messenger issue notifications open directly on the source comment", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Messenger-Issue-Comment-Anchor-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Messenger comment anchor",
      description: "Opening the Messenger issue notification should land on the source comment.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };
  const routeRef = issue.identifier ?? issue.id;

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Messenger Anchor Agent",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const agentKeyRes = await page.request.post(`/api/agents/${agent.id}/keys`, {
    data: { name: "messenger-comment-anchor-e2e" },
  });
  expect(agentKeyRes.ok()).toBe(true);
  const agentKey = await agentKeyRes.json() as { token: string };

  for (let index = 0; index < 12; index += 1) {
    const fillerRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
      data: {
        body: `Earlier context ${index + 1}\n\n${"This is filler context before the target comment. ".repeat(12)}`,
      },
    });
    expect(fillerRes.ok()).toBe(true);
  }

  const targetCommentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: {
      body: `Target comment from Messenger.\n\n${"The page should center this comment after navigation. ".repeat(10)}`,
    },
    headers: { authorization: `Bearer ${agentKey.token}` },
  });
  expect(targetCommentRes.ok()).toBe(true);
  const targetComment = await targetCommentRes.json() as { id: string };

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/issues`);
  const issueCard = page.getByTestId(`messenger-issue-card-${issue.id}`);
  await expect(issueCard).toBeVisible({ timeout: 15_000 });
  await issueCard.getByRole("link", { name: "Open issue" }).click();

  await expect(page).toHaveURL(
    `${new URL(page.url()).origin}/${organization.issuePrefix}/messenger/issues/${routeRef}#comment-${targetComment.id}`,
  );
  const targetCommentBlock = page.locator(`#comment-${targetComment.id}`);
  await expect(targetCommentBlock).toBeVisible();
  await expect(targetCommentBlock).toHaveClass(/bg-primary\/5/);

  await expect.poll(async () => page.evaluate((commentId) => {
    const container = document.getElementById("main-content");
    const comment = document.getElementById(`comment-${commentId}`);
    if (!container || !comment) return Number.POSITIVE_INFINITY;

    const containerRect = container.getBoundingClientRect();
    const commentRect = comment.getBoundingClientRect();
    const containerCenter = containerRect.top + containerRect.height / 2;
    const commentCenter = commentRect.top + commentRect.height / 2;
    return Math.abs(commentCenter - containerCenter);
  }, targetComment.id)).toBeLessThanOrEqual(120);
});

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

  const commentLink = linkCommentBlock.locator("a[data-mention-kind='issue'][data-mention-comment='true']").first();
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

test("comment hash spacer is removed after positioning the last comment", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Hash-Spacer-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Last comment stays close to composer",
      description: "Hash positioning should not leave permanent spacer below the comment thread.",
      status: "done",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };
  const routeRef = issue.identifier ?? issue.id;

  const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: {
      body: "This final comment should sit close to the comment composer after hash positioning settles.",
    },
  });
  expect(commentRes.ok()).toBe(true);
  const comment = await commentRes.json() as { id: string };

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/issues/${routeRef}#comment-${comment.id}`);

  const commentBlock = page.locator(`#comment-${comment.id}`);
  const composer = page.locator(".chat-composer").last();
  await expect(commentBlock).toBeVisible({ timeout: 15_000 });
  await expect(composer).toBeVisible();
  await expect(page.getByTestId("comment-hash-scroll-end-space")).toHaveCount(0, { timeout: 3_000 });

  const metrics = await page.evaluate((commentId) => {
    const comment = document.getElementById(`comment-${commentId}`);
    const composer = Array.from(document.querySelectorAll(".chat-composer")).at(-1);
    const timeline = document.querySelector<HTMLElement>("[data-testid='comment-thread-timeline-scroll']");
    if (!comment || !composer || !timeline) return null;
    const commentBox = comment.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    const timelineBox = timeline.getBoundingClientRect();
    return {
      gap: Math.round(composerBox.top - commentBox.bottom),
      timelineBottomGap: Math.round(composerBox.top - timelineBox.bottom),
      commentInTimeline: commentBox.bottom <= timelineBox.bottom + 1,
      spacerCount: document.querySelectorAll("[data-testid='comment-hash-scroll-end-space']").length,
    };
  }, comment.id);

  expect(metrics).not.toBeNull();
  expect(metrics!.spacerCount).toBe(0);
  expect(metrics!.gap).toBeGreaterThanOrEqual(12);
  expect(metrics!.commentInTimeline).toBe(true);
  expect(Math.abs(metrics!.timelineBottomGap)).toBeLessThanOrEqual(20);

  await page.screenshot({
    path: testInfo.outputPath("comment-hash-spacer-removed.png"),
    fullPage: true,
  });
});

test("issue comment composer stays pinned while the activity timeline scrolls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Fixed-Composer-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Comment composer should stay pinned",
      description: "The issue timeline is long enough that the comment composer must remain visible while comments scroll.",
      status: "done",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };
  const routeRef = issue.identifier ?? issue.id;

  for (let index = 0; index < 18; index += 1) {
    const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
      data: {
        body: `Scrollable comment ${index + 1}\n\n${"This comment adds realistic vertical weight to the issue activity timeline. ".repeat(8)}`,
      },
    });
    expect(commentRes.ok()).toBe(true);
  }

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/issues/${routeRef}`);
  await expect(page.locator(".chat-composer").last()).toBeVisible({ timeout: 15_000 });

  const metrics = await page.evaluate(async () => {
    const timeline = document.querySelector<HTMLElement>("[data-testid='comment-thread-timeline-scroll']");
    const composer = Array.from(document.querySelectorAll<HTMLElement>(".chat-composer")).at(-1);
    const activity = document.querySelector<HTMLElement>("section[aria-label='Activity']");
    if (!timeline || !composer || !activity) return null;

    const before = composer.getBoundingClientRect();
    timeline.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const afterTopScroll = composer.getBoundingClientRect();
    timeline.scrollTop = Math.floor(timeline.scrollHeight / 2);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const afterMiddleScroll = composer.getBoundingClientRect();
    const activityRect = activity.getBoundingClientRect();

    return {
      timelineCanScroll: timeline.scrollHeight > timeline.clientHeight + 120,
      topDelta: Math.round(Math.abs(afterTopScroll.top - afterMiddleScroll.top)),
      bottomGap: Math.round(activityRect.bottom - afterMiddleScroll.bottom),
      composerHeight: Math.round(afterMiddleScroll.height),
      beforeTop: Math.round(before.top),
      afterTop: Math.round(afterMiddleScroll.top),
    };
  });

  expect(metrics).not.toBeNull();
  expect(metrics!.timelineCanScroll).toBe(true);
  expect(metrics!.topDelta).toBeLessThanOrEqual(2);
  expect(metrics!.bottomGap).toBeGreaterThanOrEqual(0);
  expect(metrics!.bottomGap).toBeLessThanOrEqual(28);
  expect(metrics!.composerHeight).toBeGreaterThan(80);

  await page.screenshot({
    path: testInfo.outputPath("issue-comment-composer-pinned.png"),
    fullPage: false,
  });
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
    const container = document.querySelector<HTMLElement>("[data-testid='comment-thread-timeline-scroll']");
    const comment = document.getElementById(`comment-${commentId}`);
    if (!container || !comment) return Number.POSITIVE_INFINITY;

    const containerRect = container.getBoundingClientRect();
    const commentRect = comment.getBoundingClientRect();
    const containerCenter = containerRect.top + containerRect.height / 2;
    const commentCenter = commentRect.top + commentRect.height / 2;
    return Math.abs(commentCenter - containerCenter);
  }, targetComment.id)).toBeLessThanOrEqual(120);
});

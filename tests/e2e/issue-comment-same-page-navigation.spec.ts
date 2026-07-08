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
    const mainScroll = document.querySelector<HTMLElement>("[data-testid='issue-detail-main-scroll']");
    const timelineFlow = document.querySelector<HTMLElement>("[data-testid='comment-thread-timeline-flow']");
    if (!comment || !composer || !mainScroll || !timelineFlow) return null;
    const commentBox = comment.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    const mainScrollBox = mainScroll.getBoundingClientRect();
    return {
      gap: Math.round(composerBox.top - commentBox.bottom),
      composerTopPadding: Math.round(composerBox.top - timelineFlow.getBoundingClientRect().bottom),
      commentInMainScroll: commentBox.bottom <= mainScrollBox.bottom + 1,
      hasInternalTimelineScroll: Boolean(document.querySelector("[data-testid='comment-thread-timeline-scroll']")),
      spacerCount: document.querySelectorAll("[data-testid='comment-hash-scroll-end-space']").length,
    };
  }, comment.id);

  expect(metrics).not.toBeNull();
  expect(metrics!.spacerCount).toBe(0);
  expect(metrics!.hasInternalTimelineScroll).toBe(false);
  expect(metrics!.gap).toBeGreaterThanOrEqual(6);
  expect(metrics!.commentInMainScroll).toBe(true);
  expect(metrics!.composerTopPadding).toBeGreaterThanOrEqual(0);
  expect(metrics!.composerTopPadding).toBeLessThanOrEqual(10);

  await page.screenshot({
    path: testInfo.outputPath("comment-hash-spacer-removed.png"),
    fullPage: true,
  });
});

test("issue detail body and activity move through one scroll flow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Fixed-Composer-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue detail should scroll as one page",
      description: "The issue timeline is long enough that the description, activity, and composer should move as one page instead of creating a split scroll region.",
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
  await expect(page.getByTestId("issue-detail-main-scroll")).toBeVisible();
  await expect(page.getByTestId("comment-thread-timeline-flow")).toBeVisible();
  await expect(page.getByTestId("comment-thread-timeline-scroll")).toHaveCount(0);

  const metrics = await page.evaluate(async () => {
    const mainScroll = document.querySelector<HTMLElement>("[data-testid='issue-detail-main-scroll']");
    const timelineFlow = document.querySelector<HTMLElement>("[data-testid='comment-thread-timeline-flow']");
    const composer = Array.from(document.querySelectorAll<HTMLElement>(".chat-composer")).at(-1);
    const activity = document.querySelector<HTMLElement>("section[aria-label='Activity']");
    if (!mainScroll || !timelineFlow || !composer || !activity) return null;

    const before = {
      activityTop: activity.getBoundingClientRect().top,
      composerTop: composer.getBoundingClientRect().top,
      firstCommentTop: timelineFlow.querySelector<HTMLElement>("[id^='comment-']")?.getBoundingClientRect().top ?? null,
    };
    mainScroll.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const afterTopScroll = {
      activityTop: activity.getBoundingClientRect().top,
      composerTop: composer.getBoundingClientRect().top,
      firstCommentTop: timelineFlow.querySelector<HTMLElement>("[id^='comment-']")?.getBoundingClientRect().top ?? null,
    };
    mainScroll.scrollTop = Math.floor(mainScroll.scrollHeight / 2);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const afterMiddleScroll = {
      activityTop: activity.getBoundingClientRect().top,
      composerBox: composer.getBoundingClientRect(),
      firstCommentTop: timelineFlow.querySelector<HTMLElement>("[id^='comment-']")?.getBoundingClientRect().top ?? null,
    };
    const mainScrollRect = mainScroll.getBoundingClientRect();
    const timelineFlowRect = timelineFlow.getBoundingClientRect();

    return {
      mainCanScroll: mainScroll.scrollHeight > mainScroll.clientHeight + 120,
      activityMovesWithMainScroll: Math.round(afterTopScroll.activityTop - afterMiddleScroll.activityTop),
      firstCommentMovesWithMainScroll: afterTopScroll.firstCommentTop === null || afterMiddleScroll.firstCommentTop === null
        ? null
        : Math.round(afterTopScroll.firstCommentTop - afterMiddleScroll.firstCommentTop),
      stickyComposerDelta: Math.round(Math.abs(afterTopScroll.composerTop - afterMiddleScroll.composerBox.top)),
      stickyBottomGap: Math.round(mainScrollRect.bottom - afterMiddleScroll.composerBox.bottom),
      timelineFlowTop: Math.round(timelineFlowRect.top),
      timelineFlowBottom: Math.round(timelineFlowRect.bottom),
      composerTop: Math.round(afterMiddleScroll.composerBox.top),
      composerHeight: Math.round(afterMiddleScroll.composerBox.height),
      beforeActivityTop: Math.round(before.activityTop),
      beforeComposerTop: Math.round(before.composerTop),
      hasInternalTimelineScroll: Boolean(document.querySelector("[data-testid='comment-thread-timeline-scroll']")),
    };
  });

  expect(metrics).not.toBeNull();
  expect(metrics!.mainCanScroll).toBe(true);
  expect(metrics!.hasInternalTimelineScroll).toBe(false);
  expect(metrics!.activityMovesWithMainScroll).toBeGreaterThan(120);
  expect(metrics!.firstCommentMovesWithMainScroll).not.toBeNull();
  expect(metrics!.firstCommentMovesWithMainScroll!).toBeGreaterThan(120);
  expect(metrics!.stickyComposerDelta).toBeLessThanOrEqual(2);
  expect(metrics!.stickyBottomGap).toBeGreaterThanOrEqual(0);
  expect(metrics!.stickyBottomGap).toBeLessThanOrEqual(28);
  expect(metrics!.timelineFlowTop).toBeLessThan(metrics!.composerTop);
  expect(metrics!.timelineFlowBottom).toBeGreaterThan(metrics!.composerTop);
  expect(metrics!.composerHeight).toBeGreaterThan(80);

  await page.screenshot({
    path: testInfo.outputPath("issue-detail-single-scroll-flow.png"),
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
    const container = document.querySelector<HTMLElement>("[data-testid='issue-detail-main-scroll']");
    const comment = document.getElementById(`comment-${commentId}`);
    if (!container || !comment) return Number.POSITIVE_INFINITY;

    const containerRect = container.getBoundingClientRect();
    const commentRect = comment.getBoundingClientRect();
    const containerCenter = containerRect.top + containerRect.height / 2;
    const commentCenter = commentRect.top + commentRect.height / 2;
    return Math.abs(commentCenter - containerCenter);
  }, targetComment.id)).toBeLessThanOrEqual(120);
});

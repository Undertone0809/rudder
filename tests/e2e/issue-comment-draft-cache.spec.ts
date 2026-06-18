import { expect, test } from "@playwright/test";

test("keeps an unsent issue comment draft when navigating away and back", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Issue-Comment-Draft-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue comment draft should survive navigation",
      description: "Unsent comment text should be restored after route changes.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null; title: string };
  const routeRef = issue.identifier ?? issue.id;

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/issues/${routeRef}`);
  await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });

  const activity = page.getByRole("region", { name: "Activity" });
  const composer = activity.locator(".rudder-milkdown-content [contenteditable='true']").last();
  const draft = "Keep this unsent issue comment";
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await page.keyboard.type(draft);
  await expect(composer).toContainText(draft);
  await expect.poll(async () => page.evaluate((key) => (
    window.localStorage.getItem(key)
  ), `rudder:issue-comment-draft:${issue.id}`)).toContain(draft);

  await page.getByTestId("primary-rail").getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/dashboard$`), { timeout: 15_000 });

  await page.goto(`/${organization.issuePrefix}/issues/${routeRef}`);
  await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });
  await expect(activity.locator(".rudder-milkdown-content [contenteditable='true']").last()).toContainText(draft);
});

test("paints a stored issue comment draft when the real composer first appears", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Issue-Comment-Draft-Initial-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue comment draft should paint immediately",
      description: "Preloaded localStorage drafts should be present on the first editor paint.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null; title: string };
  const routeRef = issue.identifier ?? issue.id;
  const draft = "Paint this preloaded issue comment draft";
  const draftKey = `rudder:issue-comment-draft:${issue.id}`;

  await page.addInitScript(({ orgId, key, value }) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    window.localStorage.setItem(key, value);

    const state = window as typeof window & {
      __rudderFirstIssueCommentComposerText?: string | null;
      __rudderFirstIssueCommentComposerScheduled?: boolean;
    };
    state.__rudderFirstIssueCommentComposerText = null;
    state.__rudderFirstIssueCommentComposerScheduled = false;

    const scheduleCapture = () => {
      if (state.__rudderFirstIssueCommentComposerText !== null || state.__rudderFirstIssueCommentComposerScheduled) {
        return true;
      }
      const composer = document.querySelector<HTMLElement>(
        ".chat-composer .rudder-milkdown-content [contenteditable='true']",
      );
      if (!composer) return false;
      state.__rudderFirstIssueCommentComposerScheduled = true;
      requestAnimationFrame(() => {
        state.__rudderFirstIssueCommentComposerText = composer.textContent ?? "";
      });
      return true;
    };

    let observer: MutationObserver | null = null;
    const startCapture = () => {
      if (observer) return;
      const root = document.documentElement;
      if (!root) {
        setTimeout(startCapture, 0);
        return;
      }
      observer = new MutationObserver(() => {
        if (scheduleCapture()) observer?.disconnect();
      });
      observer.observe(root, {
        childList: true,
        subtree: true,
      });
      if (scheduleCapture()) observer.disconnect();
    };

    startCapture();
    window.addEventListener("DOMContentLoaded", () => {
      if (scheduleCapture()) observer?.disconnect();
    }, { once: true });
  }, { orgId: organization.id, key: draftKey, value: draft });

  await page.goto(`/${organization.issuePrefix}/issues/${routeRef}`);
  await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });

  const composer = page.getByRole("region", { name: "Activity" })
    .locator(".rudder-milkdown-content [contenteditable='true']")
    .last();
  await expect(composer).toContainText(draft);
  await expect.poll(async () => page.evaluate(() => (
    (window as typeof window & { __rudderFirstIssueCommentComposerText?: string | null })
      .__rudderFirstIssueCommentComposerText
  ))).toContain(draft);
});

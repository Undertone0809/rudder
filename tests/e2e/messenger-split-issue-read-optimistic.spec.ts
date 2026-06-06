import { expect, test, type Page } from "@playwright/test";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  createDb,
  messengerThreadUserStates,
} from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

function threadTestId(threadKey: string) {
  return `messenger-thread-${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function threadUnreadBadgeTestId(threadKey: string) {
  return `${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}-unread-badge`;
}

test("clears a split issue unread badge before mark-read returns", async ({ page }) => {
  const sessionRes = await page.request.get("/api/auth/get-session");
  expect(sessionRes.ok()).toBe(true);
  const session = await sessionRes.json();
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  expect(currentUserId).toBeTruthy();

  const organization = await createOrganization(page, `Messenger-Split-Issue-Read-${Date.now()}`);
  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Optimistic split issue read",
      description: "The sidebar unread badge should clear before the read request returns.",
      status: "todo",
      priority: "medium",
      assigneeUserId: currentUserId,
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier?: string | null; title: string };
  const issueRef = issue.identifier ?? issue.id;
  const threadKey = `issue:${issue.id}`;

  await page.addInitScript(({ orgId }) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    window.localStorage.setItem("rudder.messengerSplitIssueNotificationsByOrg", JSON.stringify({ [orgId]: true }));
  }, { orgId: organization.id });

  await page.goto(`/${organization.issuePrefix}/messenger`, { waitUntil: "commit" });

  const splitIssueRow = page.getByTestId(threadTestId(threadKey));
  const unreadBadge = page.getByTestId(threadUnreadBadgeTestId(threadKey));
  await expect(splitIssueRow).toContainText(issue.title, { timeout: 15_000 });
  await expect(unreadBadge).toHaveText("1");

  const markReadGate: { release?: () => void } = {};
  const markReadStarted = new Promise<void>((resolve) => {
    void page.route(
      `**/api/orgs/${organization.id}/messenger/threads/${encodeURIComponent(threadKey)}/read`,
      async (route) => {
        resolve();
        await new Promise<void>((release) => {
          markReadGate.release = release;
        });
        await route.continue();
      },
    );
  });

  await splitIssueRow.click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/issues/${issueRef}$`));
  await markReadStarted;
  expect(await unreadBadge.count()).toBe(0);

  markReadGate.release?.();
  await expect.poll(async () => {
    const rows = await e2eDb
      .select({ lastReadAt: messengerThreadUserStates.lastReadAt })
      .from(messengerThreadUserStates)
      .where(eq(messengerThreadUserStates.threadKey, threadKey));
    return Boolean(rows[0]?.lastReadAt);
  }).toBe(true);
});

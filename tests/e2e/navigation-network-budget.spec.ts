import { expect, test, type Page } from "@playwright/test";

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; urlKey: string }>;
}

function isTargetOrgApi(url: URL, orgId: string) {
  return url.pathname.startsWith(`/api/orgs/${orgId}/`);
}

function isUnboundedChatList(url: URL, orgId: string) {
  return url.pathname === `/api/orgs/${orgId}/chats` && !url.searchParams.has("limit");
}

function isUnboundedActivityList(url: URL, orgId: string) {
  return url.pathname === `/api/orgs/${orgId}/activity` && !url.searchParams.has("limit");
}

function isUnboundedIssueSideCatalog(url: URL, orgId: string) {
  if (url.pathname !== `/api/orgs/${orgId}/issues`) return false;
  if (url.searchParams.has("limit")) return false;
  return url.searchParams.get("includeAutomationExecutions") === "true";
}

function isUnboundedIssueList(url: URL, orgId: string) {
  return url.pathname === `/api/orgs/${orgId}/issues` && !url.searchParams.has("limit");
}

function isOffsetWithoutLimit(url: URL, orgId: string) {
  return url.pathname === `/api/orgs/${orgId}/issues`
    && url.searchParams.has("offset")
    && !url.searchParams.has("limit");
}

test.describe("navigation network budget", () => {
  test("dashboard, issues, and messenger do not trigger unbounded auxiliary lists", async ({ page }) => {
    const organization = await createOrganization(page, `Network-Budget-${Date.now()}`);
    const requestedUrls: string[] = [];

    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const url = new URL(request.url());
      if (!isTargetOrgApi(url, organization.id)) return;
      requestedUrls.push(url.toString());
    });

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    for (const route of ["dashboard", "issues", "messenger"] as const) {
      await page.goto(`/${organization.urlKey}/${route}`);
      await page.waitForLoadState("networkidle");
    }

    const offenders = requestedUrls.filter((value) => {
      const url = new URL(value);
      return (
        isUnboundedChatList(url, organization.id)
        || isUnboundedActivityList(url, organization.id)
        || isUnboundedIssueSideCatalog(url, organization.id)
        || isUnboundedIssueList(url, organization.id)
        || isOffsetWithoutLimit(url, organization.id)
      );
    });

    expect(offenders).toEqual([]);
    expect(requestedUrls.some((value) => {
      const url = new URL(value);
      return url.pathname === `/api/orgs/${organization.id}/issues`
        && url.searchParams.get("limit") === "200";
    })).toBe(true);
  });
});

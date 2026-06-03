import { expect, test } from "@playwright/test";

const ORG_NAME = `Issue-Detail-Subissues-${Date.now()}`;

test.describe("Issue detail sub-issues", () => {
  test("shows parent context in the global new sub-issue dialog from properties add", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `${ORG_NAME}-Parent-Context` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const parentTitle =
      "Investigate a very long parent issue title that should truncate cleanly in the sub issue modal";
    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: parentTitle,
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();
    const issueRef = issue.identifier ?? issue.id;

    await page.goto(`/issues/${issueRef}`);
    await page.getByRole("button", { name: "Properties" }).click();

    const propertiesDialog = page.getByRole("dialog", { name: "Properties" });
    await expect(propertiesDialog.getByText("Sub-issues", { exact: true })).toBeVisible();
    await propertiesDialog.getByRole("button", { name: "Add" }).click();
    await page.getByRole("button", { name: "Create new sub-issue" }).click();

    const newIssueDialog = page.getByRole("dialog").filter({ hasText: "New sub-issue" });
    await expect(newIssueDialog.getByText("New sub-issue", { exact: true })).toBeVisible();
    await expect(newIssueDialog.getByText("Parent", { exact: true })).toBeVisible();
    await expect(newIssueDialog.getByText(issueRef, { exact: true })).toBeVisible();
    await expect(newIssueDialog.getByText(parentTitle, { exact: true })).toBeVisible();
    await expect(newIssueDialog.getByRole("button", { name: "Create sub-issue" })).toBeVisible();

    const parentContextLayout = await newIssueDialog.locator('[data-slot="new-issue-parent-context"]').evaluate((node) => {
      const title = node.querySelector<HTMLElement>(".min-w-0.flex-1.truncate");
      const identifier = node.querySelector<HTMLElement>(".font-mono");

      return {
        rowClientWidth: node.clientWidth,
        rowScrollWidth: node.scrollWidth,
        identifierWhiteSpace: identifier ? window.getComputedStyle(identifier).whiteSpace : null,
        titleOverflowX: title ? window.getComputedStyle(title).overflowX : null,
        titleTextOverflow: title ? window.getComputedStyle(title).textOverflow : null,
        titleWhiteSpace: title ? window.getComputedStyle(title).whiteSpace : null,
      };
    });

    expect(parentContextLayout.rowScrollWidth).toBeLessThanOrEqual(parentContextLayout.rowClientWidth);
    expect(parentContextLayout.identifierWhiteSpace).toBe("nowrap");
    expect(parentContextLayout.titleOverflowX).toBe("hidden");
    expect(parentContextLayout.titleTextOverflow).toBe("ellipsis");
    expect(parentContextLayout.titleWhiteSpace).toBe("nowrap");
  });

  test("renders sub-issues inline above documents and creates child issues in place", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: ORG_NAME },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: { name: "Sub-issue parent project", status: "in_progress" },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json();

    const parentRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Parent issue container",
        status: "todo",
        priority: "medium",
      },
    });
    expect(parentRes.ok()).toBe(true);
    const parentIssue = await parentRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Parent issue for inline child creation",
        description: "Sub-issues should live in the main body layout.",
        status: "todo",
        priority: "medium",
        parentId: parentIssue.id,
        projectId: project.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const existingChildRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Existing child issue",
        status: "todo",
        priority: "medium",
        parentId: issue.id,
      },
    });
    expect(existingChildRes.ok()).toBe(true);

    const standaloneExistingRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Standalone existing issue",
        status: "todo",
        priority: "medium",
      },
    });
    expect(standaloneExistingRes.ok()).toBe(true);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    const subIssuesSection = page.getByLabel("Sub-issues");

    await expect(page.getByRole("tab", { name: "Sub-issues" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add sub-issue" })).toBeVisible();
    await expect(subIssuesSection.getByText("Sub-issues", { exact: true })).toBeVisible();
    await expect(subIssuesSection.getByText("Existing child issue", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change status for Existing child issue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New document" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Chat" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Activity" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Activity" })).toBeVisible();

    await page.getByRole("button", { name: "Add sub-issue" }).click();
    await page.getByRole("menuitem", { name: "Add existing issue" }).click();
    await expect(subIssuesSection.getByPlaceholder("Search existing issues")).toBeVisible();
    await subIssuesSection.getByPlaceholder("Search existing issues").fill("Standalone existing issue");
    await subIssuesSection.getByRole("button", { name: /Standalone existing issue/ }).click();
    await expect(subIssuesSection.getByText("Standalone existing issue", { exact: true })).toBeVisible();

    const propertiesPanel = page.getByRole("region", { name: "Issue properties" });
    await expect(propertiesPanel.getByText("Parent issue", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByText("Parent issue container", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByRole("link", { name: "Open parent issue" })).toHaveAttribute(
      "href",
      new RegExp(`/issues/${parentIssue.identifier ?? parentIssue.id}$`),
    );
    await expect(propertiesPanel.getByText("Sub-issues", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByText("Existing child issue", { exact: true })).toBeVisible();

    const subIssuesBox = await page.getByLabel("Sub-issues").boundingBox();
    const activityBox = await page.getByRole("region", { name: "Activity" }).boundingBox();
    expect(subIssuesBox).not.toBeNull();
    expect(activityBox).not.toBeNull();
    expect((subIssuesBox?.y ?? 0)).toBeLessThan(activityBox?.y ?? 0);

    await page.getByRole("button", { name: "Change status for Existing child issue" }).click();
    await expect(page).toHaveURL(new RegExp(`${issue.identifier ?? issue.id}$`));
    await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${issue.identifier ?? issue.id}$`));

    await page.getByRole("button", { name: "Add sub-issue" }).click();
    await page.getByRole("menuitem", { name: "Create new sub-issue" }).click();
    await expect(subIssuesSection.getByPlaceholder("Add sub-issue title")).toBeVisible();

    await subIssuesSection.getByPlaceholder("Add sub-issue title").fill("Inline child issue");
    await subIssuesSection.getByRole("button", { name: "Create", exact: true }).click();

    await expect(subIssuesSection.getByText("Inline child issue", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Add sub-issue title")).toHaveCount(0);
    await expect(subIssuesSection.locator("a").nth(0)).toContainText("Existing child issue");
    await expect(subIssuesSection.locator("a").nth(1)).toContainText("Standalone existing issue");
    await expect(subIssuesSection.locator("a").nth(2)).toContainText("Inline child issue");

    const childIssuesRes = await page.request.get(
      `/api/orgs/${organization.id}/issues?parentId=${encodeURIComponent(issue.id)}`,
    );
    expect(childIssuesRes.ok()).toBe(true);
    const childIssues = await childIssuesRes.json();
    expect(childIssues).toHaveLength(3);
    expect(childIssues.map((child: { title: string }) => child.title).sort()).toEqual([
      "Existing child issue",
      "Inline child issue",
      "Standalone existing issue",
    ]);
    expect(childIssues.every((child: { parentId: string }) => child.parentId === issue.id)).toBe(true);
    expect(childIssues.find((child: { title: string; status: string }) => child.title === "Existing child issue")?.status).toBe("done");
    expect(
      childIssues.find((child: { title: string; projectId: string | null }) => child.title === "Existing child issue")
        ?.projectId,
    ).toBe(project.id);
    expect(
      childIssues.find((child: { title: string; projectId: string | null }) => child.title === "Inline child issue")
        ?.projectId,
    ).toBe(project.id);
    expect(
      childIssues.find((child: { title: string; projectId: string | null }) => child.title === "Standalone existing issue")
        ?.projectId,
    ).toBeNull();

    await page.getByRole("button", { name: "Add sub-issue" }).click();
    await page.getByRole("menuitem", { name: "Create new sub-issue" }).click();
    await subIssuesSection.getByPlaceholder("Add sub-issue title").fill("Cancel me");
    await subIssuesSection.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByPlaceholder("Add sub-issue title")).toHaveCount(0);

    await expect(page.getByText("created the issue")).toBeVisible();
    await expect(page.locator('[contenteditable="true"]').last()).toBeVisible();
  });

  test("keeps long sub-issue rows inside the mobile properties sheet", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `${ORG_NAME}-Mobile` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Mobile properties parent",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const longTitle = "Investigate a very long child issue title that should truncate before the identifier";
    const childRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: longTitle,
        status: "todo",
        priority: "medium",
        parentId: issue.id,
      },
    });
    expect(childRes.ok()).toBe(true);
    const childIssue = await childRes.json();
    const childIdentifier = childIssue.identifier ?? childIssue.id.slice(0, 8);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    await page.getByRole("button", { name: "Properties" }).click();

    const propertiesDialog = page.getByRole("dialog", { name: "Properties" });
    await expect(propertiesDialog).toBeVisible();

    const childLink = propertiesDialog.getByRole("link").filter({ hasText: longTitle });
    await expect(childLink).toBeVisible();
    await expect(childLink.getByText(childIdentifier, { exact: true })).toBeVisible();

    const titleNode = childLink.getByText(longTitle, { exact: true });
    const titleLayout = await titleNode.evaluate((node) => {
      const style = window.getComputedStyle(node);

      return {
        clientWidth: node.clientWidth,
        overflowX: style.overflowX,
        scrollWidth: node.scrollWidth,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    });
    expect(titleLayout.textOverflow).toBe("ellipsis");
    expect(titleLayout.overflowX).toBe("hidden");
    expect(titleLayout.whiteSpace).toBe("nowrap");
    expect(titleLayout.clientWidth).toBeLessThan(titleLayout.scrollWidth);

    const dialogBox = await propertiesDialog.boundingBox();
    const linkBox = await childLink.boundingBox();
    const identifierBox = await childLink.getByText(childIdentifier, { exact: true }).boundingBox();

    expect(dialogBox).not.toBeNull();
    expect(linkBox).not.toBeNull();
    expect(identifierBox).not.toBeNull();

    const dialogRight = (dialogBox?.x ?? 0) + (dialogBox?.width ?? 0);
    const linkRight = (linkBox?.x ?? 0) + (linkBox?.width ?? 0);
    const identifierRight = (identifierBox?.x ?? 0) + (identifierBox?.width ?? 0);

    expect(linkBox?.x ?? 0).toBeGreaterThanOrEqual((dialogBox?.x ?? 0) - 1);
    expect(linkRight).toBeLessThanOrEqual(dialogRight + 1);
    expect(identifierRight).toBeLessThanOrEqual(linkRight + 1);
  });
});

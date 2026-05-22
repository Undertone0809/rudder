import { expect, test, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function apiPost<T>(page: Page, path: string, data: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    async ({ requestPath, payload }) => {
      const response = await fetch(requestPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`POST ${requestPath} failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    },
    { requestPath: path, payload: data },
  ) as Promise<T>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.describe("Issue board display properties", () => {
  test("toggles board card metadata independently from filters", async ({ page }) => {
    await page.goto("/");

    const organization = await apiPost<{ id: string; issuePrefix: string }>(
      page,
      "/api/orgs",
      {
        name: `Issue-Board-Display-${Date.now()}`,
      },
    );

    const project = await apiPost<{ id: string; name: string }>(
      page,
      `/api/orgs/${organization.id}/projects`,
      {
        name: "field-visibility-project",
        status: "in_progress",
      },
    );

    const label = await apiPost<{ id: string; name: string }>(
      page,
      `/api/orgs/${organization.id}/labels`,
      {
        name: "Display default",
        color: "#8b5cf6",
      },
    );

    const reviewer = await apiPost<{ id: string; name: string }>(
      page,
      `/api/orgs/${organization.id}/agents`,
      {
        name: "Tobias (Chief Executive Officer with a long review title)",
        role: "qa",
      },
    );
    const assignee = await apiPost<{ id: string; name: string }>(
      page,
      `/api/orgs/${organization.id}/agents`,
      {
        name: "Ulysses (Chief Operating Officer with a long execution title)",
        role: "engineer",
      },
    );

    const issue = await apiPost<{ identifier: string | null }>(
      page,
      `/api/orgs/${organization.id}/issues`,
      {
        projectId: project.id,
        title: "Tune board card fields",
        description: "Display properties should control board card metadata.",
        status: "todo",
        priority: "high",
        labelIds: [label.id],
        assigneeAgentId: assignee.id,
        reviewerAgentId: reviewer.id,
      },
    );

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/issues`);
    await page.getByTitle("Board view").click();

    const card = page.locator('[data-testid^="kanban-card-"]').filter({ hasText: "Tune board card fields" });
    await expect(card).toBeVisible();
    await expect(card).toContainText(project.name);
    await expect(card).toContainText(label.name);
    await expect(card).toContainText(assignee.name);
    await expect(card).toContainText("Reviewer");
    await expect(card).toContainText(reviewer.name);
    await expect(card.locator('[data-slot="kanban-card-primary-assignee"] [data-slot="kanban-card-assignee"]')).toHaveAttribute("title", new RegExp(`^Assignee: ${escapeRegExp(assignee.name)}`));
    await expect(card.locator('[data-slot="kanban-card-metadata"] [data-slot="kanban-card-reviewer"]')).toHaveAttribute("title", new RegExp(`^Reviewer: ${escapeRegExp(reviewer.name)}`));
    const cardBox = await card.boundingBox();
    const assigneeBox = await card.locator('[data-slot="kanban-card-primary-assignee"]').boundingBox();
    const reviewerBox = await card.locator('[data-slot="kanban-card-metadata"] [data-slot="kanban-card-reviewer"]').boundingBox();
    expect(cardBox).not.toBeNull();
    expect(assigneeBox).not.toBeNull();
    expect(reviewerBox).not.toBeNull();
    expect(assigneeBox!.x + assigneeBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
    expect(reviewerBox!.x + reviewerBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
    await expect(card).toContainText("Created");
    await expect(card).not.toContainText("Updated");
    await expect(card).not.toContainText(/\b\d+[dhw] ago\b|\b\d+mo ago\b/);
    if (issue.identifier) {
      await expect(card).toContainText(issue.identifier);
    }

    await page.getByTestId("issues-view-toolbar").getByRole("button", { name: /Display/ }).click();
    const displayOption = (name: string) => page.locator("label").filter({ hasText: name }).getByRole("checkbox");
    await expect(displayOption("Identifier")).toBeChecked();
    await expect(displayOption("Priority")).toBeChecked();
    await expect(displayOption("Assignee")).toBeChecked();
    await expect(displayOption("Reviewer")).toBeChecked();
    await expect(displayOption("Labels")).toBeChecked();
    await expect(displayOption("Project")).toBeChecked();
    await expect(displayOption("Updated")).not.toBeChecked();
    await expect(displayOption("Created")).toBeChecked();

    await displayOption("Project").click();
    await expect(card).not.toContainText(project.name);

    if (issue.identifier) {
      await displayOption("Identifier").click();
      await expect(card).not.toContainText(issue.identifier);
    }

    const savedDisplayProperties = await page.evaluate((orgId) => {
      const raw = window.localStorage.getItem(`rudder:issues-view:${orgId}`);
      return raw ? JSON.parse(raw).displayProperties : null;
    }, organization.id);
    expect(savedDisplayProperties).toContain("labels");
    expect(savedDisplayProperties).toContain("reviewer");
    expect(savedDisplayProperties).toContain("created");
    expect(savedDisplayProperties).not.toContain("project");
    expect(savedDisplayProperties).not.toContain("updated");
    expect(savedDisplayProperties).not.toContain("identifier");
  });

  test("sorts issue cards inside each board status lane", async ({ page }) => {
    await page.goto("/");

    const organization = await apiPost<{ id: string; issuePrefix: string }>(
      page,
      "/api/orgs",
      {
        name: `Issue-Board-Sort-${Date.now()}`,
      },
    );

    await apiPost(
      page,
      `/api/orgs/${organization.id}/issues`,
      {
        title: "Low priority board issue",
        status: "todo",
        priority: "low",
      },
    );
    await apiPost(
      page,
      `/api/orgs/${organization.id}/issues`,
      {
        title: "Critical priority board issue",
        status: "todo",
        priority: "critical",
      },
    );
    await apiPost(
      page,
      `/api/orgs/${organization.id}/issues`,
      {
        title: "High priority board issue",
        status: "todo",
        priority: "high",
      },
    );

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/issues`);
    await page.getByTitle("Board view").click();

    await page.getByTestId("issues-view-toolbar").getByRole("button", { name: /Sort/ }).click();
    await page.locator('[data-slot="popover-content"]').getByRole("button", { name: "Priority", exact: true }).click();

    const todoCards = page.locator('[data-testid="kanban-column-todo"] [data-testid^="kanban-card-"]');
    await expect(todoCards.nth(0)).toContainText("Critical priority board issue");
    await expect(todoCards.nth(1)).toContainText("High priority board issue");
    await expect(todoCards.nth(2)).toContainText("Low priority board issue");

    const savedSort = await page.evaluate((orgId) => {
      const raw = window.localStorage.getItem(`rudder:issues-view:${orgId}`);
      return raw ? JSON.parse(raw) : null;
    }, organization.id);
    expect(savedSort).toMatchObject({
      viewMode: "board",
      sortField: "priority",
      sortDir: "asc",
    });
  });
});

import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("New issue project context", () => {
  test("redirects to the created issue detail after submitting the dialog", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Redirect-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    const title = `Redirected issue ${Date.now()}`;
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder("Issue title").fill(title);

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/issues`)
      && response.ok(),
    );
    await dialog.getByRole("button", { name: "Create Issue" }).click();
    const createdIssue = await (await createResponse).json() as {
      id: string;
      identifier: string | null;
    };

    await expect(page).toHaveURL(
      new RegExp(`/${organization.issuePrefix}/issues/${createdIssue.identifier ?? createdIssue.id}$`),
    );
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(
      page.getByTestId("issue-detail-breadcrumb").getByRole("link", { name: "Issues" }),
    ).toHaveAttribute("href", new RegExp(`/${organization.issuePrefix}/issues$`));
  });

  test("prefills the selected project when opening the dialog from a project-filtered issues view", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Project-Context-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Launch Context Project",
        status: "planned",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues?projectId=${project.id}`);

    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: project.name })).toBeVisible();
  });

  test("keeps labels as a property chip when the organization has five labels", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Labels-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    for (const name of ["Operations", "Research", "Engineering", "Design", "Customer"]) {
      const labelRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/labels`, {
        data: { name, color: "#2563eb" },
      });
      expect(labelRes.ok()).toBe(true);
    }

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Labels" }).click();
    await expect(page.getByPlaceholder("Search labels...")).toBeVisible();
    await page.getByRole("button", { name: "Operations", exact: true }).click();

    const title = `Labeled issue ${Date.now()}`;
    await dialog.getByPlaceholder("Issue title").fill(title);
    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/issues`)
      && response.ok(),
    );
    await dialog.getByRole("button", { name: "Create Issue" }).click();
    const createdIssue = await (await createResponse).json() as {
      id: string;
      labelIds?: string[];
      labels?: Array<{ name: string }>;
    };

    expect(createdIssue.labelIds?.length).toBe(1);
    expect(createdIssue.labels?.map((label) => label.name)).toContain("Operations");
  });

  test("remembers new issue assignee, project, and reviewer while project context wins", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Memory-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const assigneeRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Implementation Bot",
        role: "engineer",
        title: "Engineer",
      },
    });
    expect(assigneeRes.ok()).toBe(true);
    const assignee = await assigneeRes.json() as { id: string; name: string };

    const reviewerRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Review Bot",
        role: "cto",
        title: "Chief Technology Officer",
      },
    });
    expect(reviewerRes.ok()).toBe(true);
    const reviewer = await reviewerRes.json() as { id: string; name: string };

    const rememberedProjectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Remembered Project",
        status: "planned",
      },
    });
    expect(rememberedProjectRes.ok()).toBe(true);
    const rememberedProject = await rememberedProjectRes.json() as { id: string; name: string };

    const sidebarProjectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Sidebar Project",
        status: "planned",
      },
    });
    expect(sidebarProjectRes.ok()).toBe(true);
    const sidebarProject = await sidebarProjectRes.json() as { id: string; name: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

    const firstDialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(firstDialog).toBeVisible();
    await firstDialog.getByPlaceholder("Issue title").fill(`Remember metadata ${Date.now()}`);
    await firstDialog.getByRole("button", { name: "No assignee" }).click();
    await firstDialog.getByPlaceholder("Search assignees...").fill(assignee.name);
    await firstDialog.getByPlaceholder("Search assignees...").press("Enter");
    await firstDialog.getByRole("button", { name: "No project" }).first().click();
    await firstDialog.getByPlaceholder("Search projects...").fill(rememberedProject.name);
    await firstDialog.getByPlaceholder("Search projects...").press("Enter");
    await firstDialog.getByRole("button", { name: "No reviewer" }).click();
    await firstDialog.getByPlaceholder("Search reviewers...").fill(reviewer.name);
    await firstDialog.getByPlaceholder("Search reviewers...").press("Enter");

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/issues`)
      && response.ok(),
    );
    await firstDialog.getByRole("button", { name: "Create Issue" }).click();
    await createResponse;
    await expect(firstDialog).toHaveCount(0);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

    const rememberedDialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(rememberedDialog).toBeVisible();
    await expect(rememberedDialog.getByRole("button", { name: assignee.name })).toBeVisible();
    await expect(rememberedDialog.getByRole("button", { name: rememberedProject.name })).toBeVisible();
    await expect(rememberedDialog.getByRole("button", { name: reviewer.name })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(rememberedDialog).toHaveCount(0);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues?projectId=${sidebarProject.id}`);
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

    const projectContextDialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(projectContextDialog).toBeVisible();
    await expect(projectContextDialog.getByRole("button", { name: assignee.name })).toBeVisible();
    await expect(projectContextDialog.getByRole("button", { name: sidebarProject.name })).toBeVisible();
    await expect(projectContextDialog.getByRole("button", { name: reviewer.name })).toBeVisible();
  });

  test("prefills project and lane status when creating from a project-scoped board column", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Board-Context-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Board Context Project",
        status: "planned",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues?projectId=${project.id}`);
    await page.getByTitle("Board view").click();
    await page.evaluate(() => {
      window.localStorage.setItem("rudder:issue-autosave", JSON.stringify({
        title: "Saved draft",
        description: "",
        status: "blocked",
        priority: "low",
        labelIds: [],
        assigneeValue: "",
        projectId: "",
        projectWorkspaceId: "",
        assigneeModelOverride: "",
        assigneeThinkingEffort: "",
        assigneeChrome: false,
      }));
    });
    await page.getByTestId("kanban-column-add-todo").click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: project.name })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /todo/i })).toBeVisible();
  });

  test("shows saved issue drafts in the main issues draft view and reopens one", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Draft-Recovery-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder:issue-drafts", JSON.stringify([{
        id: "draft-recovery-e2e",
        orgId,
        title: "Recovered draft issue",
        description: "This draft should be findable from the issues sidebar.",
        status: "backlog",
        priority: "high",
        labelIds: [],
        assigneeValue: "",
        projectId: "",
        projectWorkspaceId: "",
        assigneeModelOverride: "",
        assigneeThinkingEffort: "",
        assigneeChrome: false,
        createdAt: "2026-04-26T10:00:00.000Z",
        updatedAt: "2026-04-26T10:00:00.000Z",
      }]));
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);

    await expect(page.getByTestId("issue-draft-sidebar-entry")).toContainText("Draft Issues (1)");
    await page.getByTestId("issue-draft-sidebar-entry").click();
    await expect(page.getByTestId("issue-drafts-view")).toBeVisible();
    await expect(page.getByTestId("issue-draft-card")).toContainText("Recovered draft issue");
    await page.getByTestId("issue-draft-card").click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("Issue title")).toHaveValue("Recovered draft issue");
    await expect(dialog.getByRole("button", { name: "Save Draft" })).toHaveCount(0);
    await expect(dialog.getByText("Saved to Draft Issues")).toBeVisible();
    await dialog.getByPlaceholder("Issue title").fill("Recovered draft issue edited");
    await page.waitForTimeout(900);
    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("rudder:issue-autosave"))).toBeNull();
    await expect.poll(async () => page.evaluate(() => {
      const drafts = JSON.parse(window.localStorage.getItem("rudder:issue-drafts") ?? "[]") as Array<{
        id: string;
        title: string;
      }>;
      return drafts.find((draft) => draft.id === "draft-recovery-e2e")?.title;
    })).toBe("Recovered draft issue edited");

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

    const newIssueDialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(newIssueDialog).toBeVisible();
    await expect(newIssueDialog.getByPlaceholder("Issue title")).toHaveValue("");
  });

  test("opens the main draft issues view for multiple saved issue drafts", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Draft-Picker-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder:issue-drafts", JSON.stringify([
        {
          id: "draft-newer-e2e",
          orgId,
          title: "Newer draft issue",
          description: "This draft should be listed first.",
          status: "backlog",
          priority: "high",
          labelIds: [],
          assigneeValue: "",
          projectId: "",
          projectWorkspaceId: "",
          assigneeModelOverride: "",
          assigneeThinkingEffort: "",
          assigneeChrome: false,
          createdAt: "2026-04-26T10:00:00.000Z",
          updatedAt: "2026-04-26T11:00:00.000Z",
        },
        {
          id: "draft-older-e2e",
          orgId,
          title: "Older draft issue",
          description: "This is the draft the user selects.",
          status: "todo",
          priority: "medium",
          labelIds: [],
          assigneeValue: "",
          projectId: "",
          projectWorkspaceId: "",
          assigneeModelOverride: "",
          assigneeThinkingEffort: "",
          assigneeChrome: false,
          createdAt: "2026-04-26T09:00:00.000Z",
          updatedAt: "2026-04-26T09:00:00.000Z",
        },
      ]));
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);

    await expect(page.getByTestId("issue-draft-sidebar-entry")).toContainText("Draft Issues (2)");
    await page.getByTestId("issue-draft-sidebar-entry").click();
    await expect(page).toHaveURL(/scope=drafts/);

    const selectedDraft = page.getByTestId("issue-draft-card").filter({ hasText: "Older draft issue" });
    await expect(selectedDraft).toBeVisible();
    await selectedDraft.click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("Issue title")).toHaveValue("Older draft issue");
  });

  test("deletes a saved draft issue from the main issues draft view", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Draft-Delete-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder:issue-drafts", JSON.stringify([
        {
          id: "draft-delete-e2e",
          orgId,
          title: "Delete me draft issue",
          description: "This draft should animate before it is removed.",
          status: "todo",
          priority: "medium",
          labelIds: [],
          assigneeValue: "",
          projectId: "",
          projectWorkspaceId: "",
          assigneeModelOverride: "",
          assigneeThinkingEffort: "",
          assigneeChrome: false,
          createdAt: "2026-04-26T09:00:00.000Z",
          updatedAt: "2026-04-26T09:00:00.000Z",
        },
        {
          id: "draft-keep-e2e",
          orgId,
          title: "Keep me draft issue",
          description: "This draft should remain visible and stable.",
          status: "backlog",
          priority: "low",
          labelIds: [],
          assigneeValue: "",
          projectId: "",
          projectWorkspaceId: "",
          assigneeModelOverride: "",
          assigneeThinkingEffort: "",
          assigneeChrome: false,
          createdAt: "2026-04-26T08:00:00.000Z",
          updatedAt: "2026-04-26T08:00:00.000Z",
        },
      ]));
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);
    await page.getByTestId("issue-draft-sidebar-entry").click();

    const deletingDraft = page.getByTestId("issue-draft-card").filter({ hasText: "Delete me draft issue" });
    const remainingDraft = page.getByTestId("issue-draft-card").filter({ hasText: "Keep me draft issue" });
    await expect(deletingDraft).toBeVisible();
    await expect(remainingDraft).toBeVisible();
    await deletingDraft.getByTestId("issue-draft-delete-button").click();

    const confirmDialog = page.locator('[data-slot="dialog-content"]').filter({
      has: page.getByText('Delete draft issue "Delete me draft issue"?'),
    }).first();
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Delete" }).click();

    await expect(remainingDraft).toBeVisible();
    await expect(deletingDraft).toHaveCount(0);
    await expect(page.getByTestId("issue-draft-sidebar-entry")).toContainText("Draft Issues (1)");
    await expect(page.getByText("Draft issue deleted")).toBeVisible();

    const storedDraftTitles = await page.evaluate(() => {
      const drafts = JSON.parse(window.localStorage.getItem("rudder:issue-drafts") ?? "[]") as Array<{ title: string }>;
      return drafts.map((draft) => draft.title);
    });
    expect(storedDraftTitles).toEqual(["Keep me draft issue"]);
  });

  test("does not show execution workspace controls in the new issue dialog", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-No-Execution-Workspace-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "No execution workspace project",
        status: "planned",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues?projectId=${project.id}`);
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: project.name })).toBeVisible();
    await expect(dialog.getByText("Execution workspace", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Reuse existing workspace", { exact: true })).toHaveCount(0);
  });
});

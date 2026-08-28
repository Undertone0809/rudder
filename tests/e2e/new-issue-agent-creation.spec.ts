import { expect, test, type Page } from "@playwright/test";
import {
  E2E_AGENT_ISSUE_CREATION_STUB,
  E2E_BASE_URL,
  E2E_CODEX_ERROR_STUB,
  E2E_CODEX_STUB,
} from "./support/e2e-env";

type Organization = { id: string; issuePrefix: string; urlKey?: string };
type Agent = { id: string };
type AgentIssueCreationRequest = {
  id: string;
  idempotencyKey: string;
  wakeupAttempt: number;
  wakeupAttemptId: string;
  status: string;
  wakeupRequestId: string | null;
  runId: string | null;
  createdIssueId: string | null;
  error?: string | null;
  instruction: string;
};
type AgentRun = {
  id: string;
  status: string;
  wakeupRequestId: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};
type ActivityEntry = {
  action: string;
  entityId: string;
  runId?: string | null;
  details?: Record<string, unknown> | null;
};

function organizationPath(organization: Organization) {
  return organization.urlKey || organization.issuePrefix;
}

async function createOrganization(page: Page, suffix: string): Promise<Organization> {
  const issueKeySuffix = String(suffix).replace(/[^a-zA-Z0-9]/g, "").slice(-8).toUpperCase();
  const response = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: {
      name: `New-Issue-Agent-${suffix}`,
      issuePrefix: `NIA${issueKeySuffix}`,
    },
  });
  expect(response.ok()).toBe(true);
  return await response.json() as Organization;
}

async function createAgent(
  page: Page,
  organization: Organization,
  name: string,
  command: string,
): Promise<Agent> {
  const response = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
    data: {
      name,
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command,
      },
    },
  });
  expect(response.ok()).toBe(true);
  return await response.json() as Agent;
}

async function createCancellableAgent(
  page: Page,
  organization: Organization,
  name: string,
): Promise<Agent> {
  const response = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
    data: {
      name,
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
      },
    },
  });
  expect(response.ok()).toBe(true);
  return await response.json() as Agent;
}

async function selectOrganization(page: Page, organization: Organization) {
  await page.goto(E2E_BASE_URL);
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
}

async function openNewIssueDialog(page: Page) {
  const desktopCreateButton = page
    .getByTestId("workspace-main-header")
    .getByRole("button", { name: "Create Issue" });
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await desktopCreateButton.click();
    return;
  }

  await page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("button", { name: "Create", exact: true })
    .click();
}

async function waitForRequest(
  page: Page,
  organization: Organization,
  requestId: string,
  expectedStatus: string,
) {
  await expect.poll(async () => {
    const response = await page.request.get(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/agent-issue-creation-requests/${requestId}`,
    );
    if (!response.ok()) return `http-${response.status()}`;
    return (await response.json() as AgentIssueCreationRequest).status;
  }, { timeout: 90_000, intervals: [250, 500, 1_000, 2_000] }).toBe(expectedStatus);

  const response = await page.request.get(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/agent-issue-creation-requests/${requestId}`,
  );
  expect(response.ok()).toBe(true);
  return await response.json() as AgentIssueCreationRequest;
}

async function waitForRun(page: Page, runId: string, expectedStatus: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`${E2E_BASE_URL}/api/agent-runs/${runId}`);
    if (!response.ok()) return `http-${response.status()}`;
    return (await response.json() as AgentRun).status;
  }, { timeout: 90_000, intervals: [250, 500, 1_000, 2_000] }).toBe(expectedStatus);

  const response = await page.request.get(`${E2E_BASE_URL}/api/agent-runs/${runId}`);
  expect(response.ok()).toBe(true);
  return await response.json() as AgentRun;
}

async function getMessengerIssues(page: Page, organization: Organization) {
  const response = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/messenger/issues`);
  expect(response.ok()).toBe(true);
  return await response.json() as {
    detail: {
      unreadCount: number;
      items: Array<{
        issueId: string;
        issueIdentifier: string | null;
        preview: string | null;
        body: string | null;
      }>;
    };
  };
}

async function getActivity(page: Page, organization: Organization, query: string) {
  const response = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/activity?${query}`);
  expect(response.ok()).toBe(true);
  return await response.json() as ActivityEntry[];
}

test.describe("New issue Agent creation", () => {
  test("undoes the exact Agent creation Run and restores the editable Agent draft", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const screenshotPath = (name: string) =>
      process.env.RUDDER_E2E_SCREENSHOT_DIR
        ? `${process.env.RUDDER_E2E_SCREENSHOT_DIR}/${name}`
        : testInfo.outputPath(name);
    const suffix = Date.now();
    const organization = await createOrganization(page, `undo-${suffix}`);
    const agent = await createCancellableAgent(page, organization, "Undo Issue Builder");
    const instruction = `Keep this exact Agent draft after Undo [E2E:${suffix}].`;
    const savedDescription = "Keep this saved-draft content editable after cancelling the Agent Run.";
    const submittedDescription = `${savedDescription}${instruction}`;
    const savedDraftId = `undo-saved-draft-${suffix}`;
    const restoredTitle = `Editable after Undo ${suffix}`;

    await selectOrganization(page, organization);
    await page.evaluate(({ orgId, draftId, title, savedDescription }) => {
      window.localStorage.setItem("rudder:issue-drafts", JSON.stringify([{
        id: draftId,
        orgId,
        title,
        description: savedDescription,
        status: "backlog",
        priority: "high",
        labelIds: [],
        assigneeValue: "",
        reviewerValue: "",
        projectId: "",
        goalId: "",
        projectWorkspaceId: "",
        assigneeModelOverride: "",
        assigneeThinkingEffort: "",
        assigneeChrome: false,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      }]));
    }, { orgId: organization.id, draftId: savedDraftId, title: restoredTitle, savedDescription });
    await page.goto(`${E2E_BASE_URL}/${organizationPath(organization)}/issues`);
    await page.getByTestId("issue-draft-sidebar-entry").click();
    await page.getByTestId("issue-draft-card").filter({ hasText: restoredTitle }).click();
    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog.getByText("Saved to Draft Issues")).toBeVisible();
    await dialog.getByRole("tab", { name: "Agent", exact: true }).click();
    await dialog.getByRole("button", { name: "Select an Agent" }).click();
    await page.locator("[data-inline-entity-option]").filter({ hasText: "Undo Issue Builder" }).click();
    await dialog.locator('[data-slot="agent-issue-description"] .cm-content').click();
    await page.keyboard.insertText(instruction);

    const acceptedResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/agent-issue-creation-requests`),
    );
    await dialog.getByRole("button", { name: "Send to Agent" }).click();
    const acceptedResponse = await acceptedResponsePromise;
    expect(acceptedResponse.status()).toBe(202);
    const accepted = await acceptedResponse.json() as AgentIssueCreationRequest;
    expect(accepted.runId).toEqual(expect.any(String));

    const toast = page.locator(`[data-toast-id="agent-issue-request-${accepted.id}"]`);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("data-countdown", "true");
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    const countdownDuration = await toast.evaluate((element) =>
      (element as HTMLElement).style.getPropertyValue("--motion-toast-countdown-duration"));
    expect(countdownDuration).toBe("12000ms");
    if (process.env.RUDDER_CAPTURE_AGENT_ISSUE_SCREENSHOTS === "1") {
      await page.waitForTimeout(300);
      await page.screenshot({ path: screenshotPath("agent-issue-undo-desktop.png"), fullPage: false });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: screenshotPath("agent-issue-undo-mobile.png"), fullPage: false });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForTimeout(50);
      await page.screenshot({ path: screenshotPath("agent-issue-undo-reduced-motion.png"), fullPage: false });
      await page.setViewportSize({ width: 1280, height: 800 });
    }

    let cancellationCount = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST"
        && new URL(request.url()).pathname === `/api/agent-runs/${accepted.runId}/cancel`
      ) cancellationCount += 1;
    });
    const cancelResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/agent-runs/${accepted.runId}/cancel`,
    );
    const undoButton = toast.getByRole("button", { name: "Undo" });
    await undoButton.evaluate((button) => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    });
    const cancelResponse = await cancelResponsePromise;
    expect(cancelResponse.ok()).toBe(true);
    expect((await cancelResponse.json() as AgentRun).status).toBe("cancelled");
    expect(cancellationCount).toBe(1);

    await expect(toast).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Agent", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dialog).toContainText("Undo Issue Builder");
    const restoredInstruction = await dialog
      .locator('[data-slot="agent-issue-description"] .cm-content')
      .evaluate((element) => {
        const tile = Reflect.get(element, "cmTile") as {
          root?: { view?: { state?: { doc?: { toString(): string } } } };
        } | undefined;
        return tile?.root?.view?.state?.doc?.toString() ?? null;
      });
    expect(restoredInstruction).toBe(submittedDescription);
    await expect(dialog.getByRole("button", { name: "Send to Agent" })).toBeEnabled();
    await expect(dialog.getByText("Failed to send the Agent request. Try again.")).toHaveCount(0);
    await waitForRequest(page, organization, accepted.id, "cancelled");

    await dialog.getByRole("tab", { name: "Manual", exact: true }).click();
    await expect(dialog.getByText("Saved to Draft Issues")).toHaveCount(0);
    await expect(dialog.getByPlaceholder("Issue title")).toHaveValue(restoredTitle);
    const editedTitle = `${restoredTitle} edited`;
    await dialog.getByPlaceholder("Issue title").fill(editedTitle);
    await expect.poll(async () => page.evaluate((deletedDraftId) => {
      const savedDrafts = JSON.parse(window.localStorage.getItem("rudder:issue-drafts") ?? "[]") as Array<{ id: string }>;
      const autosave = JSON.parse(window.localStorage.getItem("rudder:issue-autosave") ?? "null") as { title?: string } | null;
      return {
        sourceDraftDeleted: !savedDrafts.some((draft) => draft.id === deletedDraftId),
        autosaveTitle: autosave?.title ?? null,
      };
    }, savedDraftId), {
      timeout: 5_000,
      intervals: [250, 500],
    }).toEqual({ sourceDraftDeleted: true, autosaveTitle: editedTitle });
  });

  test("keeps failed Undo feedback and removes Undo when the Run becomes terminal", async ({ page }) => {
    test.setTimeout(120_000);
    const suffix = Date.now();
    const organization = await createOrganization(page, `undo-failure-${suffix}`);
    const agent = await createCancellableAgent(page, organization, "Undo Failure Builder");

    await selectOrganization(page, organization);
    await page.goto(`${E2E_BASE_URL}/${organizationPath(organization)}/issues`);
    await openNewIssueDialog(page);
    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await dialog.getByRole("tab", { name: "Agent", exact: true }).click();
    await dialog.getByRole("button", { name: "Select an Agent" }).click();
    await page.locator("[data-inline-entity-option]").filter({ hasText: "Undo Failure Builder" }).click();
    await dialog.locator('[data-slot="agent-issue-description"] .cm-content').click();
    await page.keyboard.insertText(`Preserve this draft after a failed Undo [E2E:${suffix}].`);

    const acceptedResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/agent-issue-creation-requests`),
    );
    await dialog.getByRole("button", { name: "Send to Agent" }).click();
    const accepted = await (await acceptedResponsePromise).json() as AgentIssueCreationRequest;
    const toast = page.locator(`[data-toast-id="agent-issue-request-${accepted.id}"]`);
    await expect(toast).toBeVisible();

    await page.route(`**/api/agent-runs/${accepted.runId}/cancel`, async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Cancellation unavailable" }) });
    });
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(toast).toContainText("Couldn't cancel Agent Run");
    await expect(toast).toContainText("Cancellation unavailable");
    await expect(toast.getByRole("button", { name: "Undo" })).toBeEnabled();
    await expect(dialog).toBeHidden();

    await page.unroute(`**/api/agent-runs/${accepted.runId}/cancel`);
    const terminalResponse = await page.request.post(`${E2E_BASE_URL}/api/agent-runs/${accepted.runId}/cancel`, { data: {} });
    expect(terminalResponse.ok()).toBe(true);
    await expect(toast.getByRole("button", { name: "Undo" })).toHaveCount(0, { timeout: 10_000 });
    await expect(toast).toContainText("Agent Run can no longer be cancelled");
    await expect(dialog).toBeHidden();
  });

  test("creates one real Issue, persists completion, and opens the unread Messenger result", async ({ page }, testInfo) => {
    const screenshotPath = (name: string) =>
      process.env.RUDDER_E2E_SCREENSHOT_DIR
        ? `${process.env.RUDDER_E2E_SCREENSHOT_DIR}/${name}`
        : testInfo.outputPath(name);
    const suffix = Date.now();
    const organization = await createOrganization(page, String(suffix));
    const agent = await createAgent(page, organization, "Issue Creation Builder", E2E_AGENT_ISSUE_CREATION_STUB);
    const instruction = `Create a reliability follow-up for the background issue flow [E2E:${suffix}].`;

    await selectOrganization(page, organization);
    await page.goto(`${E2E_BASE_URL}/${organizationPath(organization)}/issues`);
    await openNewIssueDialog(page);

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close new issue dialog" })).toHaveCount(1);
    await dialog.getByRole("tab", { name: "Agent", exact: true }).click();
    await dialog.getByRole("button", { name: "Select an Agent" }).click();
    await page.locator("[data-inline-entity-option]").filter({ hasText: "Issue Creation Builder" }).click();
    await expect(dialog.getByPlaceholder("Search Agents...")).toBeHidden();
    const instructionEditor = dialog.locator('[data-slot="agent-issue-description"]');
    const instructionContent = instructionEditor.locator(".cm-content");
    await instructionContent.click();
    await page.keyboard.insertText(instruction);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(dialog.getByPlaceholder("Search Agents...")).toBeHidden();

    const uploadResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/assets/images`)
      && response.status() === 201,
    );
    await instructionContent.evaluate(async (element) => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Failed to create Agent instruction paste image");
      context.fillStyle = "#111827";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#34d399";
      context.fillRect(20, 20, 120, 50);

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Failed to create Agent instruction PNG blob");
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([blob], "agent-instruction.png", { type: "image/png" }));
      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", { value: dataTransfer });
      element.dispatchEvent(pasteEvent);
    });
    const uploadedAsset = await (await uploadResponsePromise).json() as { contentPath: string };
    await expect(instructionEditor.locator(`img[src="${uploadedAsset.contentPath}"]`)).toBeVisible();
    if (process.env.RUDDER_CAPTURE_AGENT_ISSUE_SCREENSHOTS === "1") {
      await page.screenshot({ path: screenshotPath("agent-issue-dialog.png"), fullPage: false });
    }
    let agentRequestCount = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST"
        && request.url().endsWith(`/api/orgs/${organization.id}/agent-issue-creation-requests`)
      ) {
        agentRequestCount += 1;
      }
    });

    const requestPromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/agent-issue-creation-requests`),
    );
    const sendButton = dialog.getByRole("button", { name: "Send to Agent" });
    // Keep both events in one browser task so dialog teardown cannot detach
    // the second locator action before the duplicate-submit guard runs.
    await sendButton.evaluate((button) => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    });
    const acceptedResponse = await requestPromise;
    expect(acceptedResponse.status()).toBe(202);
    const accepted = await acceptedResponse.json() as AgentIssueCreationRequest;
    expect(accepted.instruction).toContain(instruction);
    expect(accepted.instruction).toContain(`![agent-instruction.png](${uploadedAsset.contentPath})`);

    await expect(dialog).toBeHidden();
    expect(agentRequestCount).toBe(1);
    await expect(page.getByText("Sent to Agent. You'll be notified in Inbox when it's done.", { exact: true })).toBeVisible();
    if (process.env.RUDDER_CAPTURE_AGENT_ISSUE_SCREENSHOTS === "1") {
      await page.screenshot({ path: screenshotPath("agent-issue-accepted-toast.png"), fullPage: false });
    }
    const completed = await waitForRequest(page, organization, accepted.id, "succeeded");
    expect(completed).toMatchObject({
      status: "succeeded",
      wakeupRequestId: expect.any(String),
      runId: expect.any(String),
      createdIssueId: expect.any(String),
    });

    const run = await waitForRun(page, completed.runId!, "succeeded");
    expect(run).toMatchObject({
      id: completed.runId,
      status: "succeeded",
      wakeupRequestId: completed.wakeupRequestId,
      contextSnapshot: expect.objectContaining({
        agentIssueCreationRequestId: accepted.id,
        targetId: accepted.id,
      }),
    });

    const runIssuesResponse = await page.request.get(`${E2E_BASE_URL}/api/agent-runs/${completed.runId}/issues`);
    expect(runIssuesResponse.ok()).toBe(true);
    expect(await runIssuesResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: completed.createdIssueId }),
    ]));

    const requestActivity = await getActivity(
      page,
      organization,
      `entityType=agent_issue_creation_request&entityId=${accepted.id}`,
    );
    expect(requestActivity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "agent.issue_creation_requested",
        entityId: accepted.id,
      }),
    ]));

    const badgeResponse = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/sidebar-badges`);
    expect(badgeResponse.ok()).toBe(true);
    expect(await badgeResponse.json()).toMatchObject({
      inbox: expect.any(Number),
      unreadTouchedIssues: 1,
    });

    const issueResponse = await page.request.get(`${E2E_BASE_URL}/api/issues/${completed.createdIssueId}`);
    expect(issueResponse.ok()).toBe(true);
    const issue = await issueResponse.json() as {
      id: string;
      identifier: string;
      title: string;
      description: string;
      status: string;
      originKind?: string;
      originId?: string;
      originRunId?: string;
    };
    expect(issue).toMatchObject({
      id: completed.createdIssueId,
      title: `Agent-created [E2E:${suffix}]`,
      status: "todo",
      originKind: "agent_issue_creation",
      originId: accepted.id,
      originRunId: completed.runId,
    });
    expect(issue.description).toContain(instruction);

    const issueActivity = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.identifier}/activity`);
    expect(issueActivity.ok()).toBe(true);
    expect(await issueActivity.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "agent.issue_created_notification",
        entityId: issue.id,
        runId: completed.runId,
        details: expect.objectContaining({
          requestId: accepted.id,
          userId: expect.any(String),
        }),
      }),
    ]));

    await expect.poll(async () => {
      const messenger = await getMessengerIssues(page, organization);
      const item = messenger.detail.items.find((candidate) => candidate.issueId === issue.id);
      return {
        unreadCount: messenger.detail.unreadCount,
        preview: item?.preview ?? item?.body ?? null,
      };
    }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toMatchObject({
      preview: expect.stringContaining("Agent created issue"),
    });

    await page.goto(`${E2E_BASE_URL}/${organizationPath(organization)}/inbox/unread`);
    await expect(page).toHaveURL(new RegExp(`/${organizationPath(organization)}/inbox/unread$`));
    const inbox = page.getByTestId("inbox-page");
    await expect(inbox).toBeVisible();
    const inboxIssueRow = page.getByTestId(`inbox-issue-${issue.id}`);
    await expect(inboxIssueRow).toBeVisible();
    await expect(inboxIssueRow).toContainText(issue.identifier);
    if (process.env.RUDDER_CAPTURE_AGENT_ISSUE_SCREENSHOTS === "1") {
      await page.screenshot({ path: screenshotPath("agent-issue-inbox.png"), fullPage: false });
    }

    await inboxIssueRow.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/${organizationPath(organization)}/issues/${issue.identifier}$`));
    await expect(page.getByRole("heading", { name: issue.title })).toBeVisible();
    await page.goto(`${E2E_BASE_URL}/${organizationPath(organization)}/inbox/unread`);
    await expect(page.getByTestId(`inbox-issue-${issue.id}`)).toHaveCount(0);

    await page.goto(`${E2E_BASE_URL}/${organizationPath(organization)}/messenger/issues`);
    const splitThreadRow = page.getByTestId(`messenger-thread-issue-${issue.id}`);
    const messageCard = page.getByTestId(`messenger-issue-card-${issue.id}`);
    await expect(messageCard).toBeVisible();
    await expect(messageCard).toContainText("Agent created issue");
    if (await splitThreadRow.count()) {
      await expect(splitThreadRow).toBeVisible();
      await expect(splitThreadRow).toContainText(issue.title);
    }
    if (process.env.RUDDER_CAPTURE_AGENT_ISSUE_SCREENSHOTS === "1") {
      await page.screenshot({ path: screenshotPath("agent-issue-messenger-result.png"), fullPage: false });
    }
    await messageCard.getByRole("link", { name: "Open issue" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organizationPath(organization)}/messenger/issues/${issue.identifier}$`));
    await expect(page.getByRole("heading", { name: issue.title })).toBeVisible();
  });

  test("deduplicates concurrent Agent submissions and completes one Issue", async ({ page }) => {
    const suffix = Date.now();
    const organization = await createOrganization(page, String(suffix));
    const agent = await createAgent(page, organization, "Idempotent Issue Builder", E2E_AGENT_ISSUE_CREATION_STUB);
    const instruction = `Create one idempotent issue for background work [E2E:${suffix}].`;
    const payload = {
      agentId: agent.id,
      instruction,
      idempotencyKey: `agent-issue-e2e-${suffix}`,
      contextSnapshot: { source: "new-issue-e2e" },
    };

    const [firstResponse, secondResponse] = await Promise.all([
      page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agent-issue-creation-requests`, { data: payload }),
      page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agent-issue-creation-requests`, { data: payload }),
    ]);
    expect(firstResponse.status()).toBe(202);
    expect(secondResponse.status()).toBe(202);
    const first = await firstResponse.json() as AgentIssueCreationRequest;
    const second = await secondResponse.json() as AgentIssueCreationRequest;
    expect(second.id).toBe(first.id);

    const completed = await waitForRequest(page, organization, first.id, "succeeded");
    expect(completed.createdIssueId).toBeTruthy();
    const issueListResponse = await page.request.get(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/issues?originKind=agent_issue_creation&originId=${completed.id}`,
    );
    expect(issueListResponse.ok()).toBe(true);
    const issues = await issueListResponse.json() as Array<{ id: string; originId?: string }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: completed.createdIssueId, originId: completed.id });

    const runListResponse = await page.request.get(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/agent-runs?agentId=${agent.id}&limit=100`,
    );
    expect(runListResponse.ok()).toBe(true);
    const runs = await runListResponse.json() as Array<{
      id: string;
      wakeupRequestId?: string | null;
      contextSnapshot?: Record<string, unknown> | null;
    }>;
    const requestRuns = runs.filter((run) => run.contextSnapshot?.agentIssueCreationRequestId === completed.id);
    expect(requestRuns).toHaveLength(1);
    expect(requestRuns[0]).toMatchObject({ id: completed.runId, wakeupRequestId: completed.wakeupRequestId });
  });

  test("persists runtime failure and rejects cross-organization Agent references", async ({ page }) => {
    const suffix = Date.now();
    const organization = await createOrganization(page, String(suffix));
    const otherOrganization = await createOrganization(page, `${suffix}-other`);
    const failingAgent = await createAgent(page, organization, "Failing Issue Builder", E2E_CODEX_ERROR_STUB);

    const requestResponse = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/agent-issue-creation-requests`,
      {
        data: {
          agentId: failingAgent.id,
          instruction: `Fail while creating this issue [E2E:${suffix}].`,
          idempotencyKey: `agent-issue-failure-${suffix}`,
          contextSnapshot: { source: "new-issue-e2e-failure" },
        },
      },
    );
    expect(requestResponse.status()).toBe(202);
    const accepted = await requestResponse.json() as AgentIssueCreationRequest;
    const failed = await waitForRequest(page, organization, accepted.id, "failed");
    expect(failed).toMatchObject({ status: "failed", runId: expect.any(String) });
    expect(failed.error).toBeTruthy();

    const retryResponse = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/agent-issue-creation-requests/${accepted.id}/retry`,
      { data: {} },
    );
    expect(retryResponse.status()).toBe(202);
    const retried = await retryResponse.json() as AgentIssueCreationRequest;
    expect(retried).toMatchObject({
      id: accepted.id,
      status: expect.stringMatching(/^(queued|running|deferred)$/),
      runId: expect.any(String),
      wakeupRequestId: expect.any(String),
      wakeupAttempt: accepted.wakeupAttempt + 1,
    });
    expect(retried.idempotencyKey).toBe(accepted.idempotencyKey);
    expect(retried.wakeupAttemptId).not.toBe(accepted.wakeupAttemptId);
    expect(retried.runId).not.toBe(failed.runId);
    const retriedFailure = await waitForRequest(page, organization, accepted.id, "failed");
    expect(retriedFailure.runId).not.toBe(failed.runId);

    const delayedOriginalReplay = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/agent-issue-creation-requests`,
      {
        data: {
          agentId: failingAgent.id,
          instruction: `Fail while creating this issue [E2E:${suffix}].`,
          idempotencyKey: accepted.idempotencyKey,
          contextSnapshot: { source: "new-issue-e2e-delayed-replay" },
        },
      },
    );
    expect(delayedOriginalReplay.status()).toBe(409);
    expect((await delayedOriginalReplay.json()).error).toContain("already terminal");

    await selectOrganization(page, organization);
    await page.goto(`${E2E_BASE_URL}/${organizationPath(organization)}/messenger/system/failed-runs`);
    const messengerFailureCard = page.getByTestId(`messenger-system-card-failed-runs-${retriedFailure.runId}`);
    await expect(messengerFailureCard).toBeVisible();
    await expect(messengerFailureCard).toContainText("Agent Issue creation failed");
    await expect(messengerFailureCard.getByRole("button", { name: "Retry Agent Issue" })).toBeVisible();

    await page.goto(`${E2E_BASE_URL}/${organizationPath(organization)}/inbox/recent`);
    await expect(page).toHaveURL(new RegExp(`/${organizationPath(organization)}/inbox/recent$`));
    const inboxFailureRow = page.getByTestId(`inbox-failed-agent-run-${retriedFailure.runId}`);
    await expect(inboxFailureRow).toBeVisible();
    await expect(inboxFailureRow).toContainText("Agent Issue creation failed");
    await expect(inboxFailureRow.getByRole("button", { name: "Retry Agent Issue" })).toBeVisible();

    const crossOrganizationResponse = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${otherOrganization.id}/agent-issue-creation-requests`,
      {
        data: {
          agentId: failingAgent.id,
          instruction: "This Agent belongs to another organization.",
          idempotencyKey: `agent-issue-cross-org-${suffix}`,
          contextSnapshot: { source: "new-issue-e2e-boundary" },
        },
      },
    );
    expect(crossOrganizationResponse.status()).toBe(422);
  });

  test("shares Description, assignee, and project across Manual and Agent creation", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const screenshotPath = (name: string) =>
      process.env.RUDDER_E2E_SCREENSHOT_DIR
        ? `${process.env.RUDDER_E2E_SCREENSHOT_DIR}/${name}`
        : testInfo.outputPath(name);
    const suffix = Date.now();
    const organization = await createOrganization(page, String(suffix));
    const agent = await createAgent(page, organization, "Deferred Builder", E2E_CODEX_STUB);
    const alternateAgent = await createAgent(page, organization, "Alternate Builder", E2E_CODEX_STUB);
    const projectResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: { name: "Shared Modal Project", status: "planned" },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = await projectResponse.json() as { id: string; name: string };
    const alternateProjectResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: { name: "Alternate Modal Project", status: "planned" },
    });
    expect(alternateProjectResponse.ok()).toBe(true);
    const alternateProject = await alternateProjectResponse.json() as { id: string; name: string };

    const pauseRes = await page.request.post(`${E2E_BASE_URL}/api/agents/${alternateAgent.id}/pause`);
    expect(pauseRes.ok()).toBe(true);
    expect((await pauseRes.json() as { status: string }).status).toBe("paused");

    await selectOrganization(page, organization);
    await page.goto(`${E2E_BASE_URL}/${organizationPath(organization)}/issues`);
    await expect(page.getByRole("link", { name: project.name, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: alternateProject.name, exact: true })).toBeVisible();

    await openNewIssueDialog(page);
    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    const manualTitle = `Manual shared-state issue ${suffix}`;
    const manualDescription = "Description entered before switching to Agent mode.";
    await dialog.getByPlaceholder("Issue title").fill(manualTitle);
    await dialog.getByRole("button", { name: "No assignee" }).click();
    await dialog.getByPlaceholder("Search assignees...").fill("Deferred Builder");
    await page.locator("[data-inline-entity-option]").filter({ hasText: "Deferred Builder" }).click();
    await expect(dialog.getByPlaceholder("Search assignees...")).toBeHidden();
    await dialog.getByRole("button", { name: "No project" }).first().click();
    await dialog.getByPlaceholder("Search projects...").fill(project.name);
    await page.locator('[data-inline-entity-option]:visible').filter({ hasText: project.name }).click({ force: true });
    await expect(dialog.getByPlaceholder("Search projects...")).toBeHidden();
    await dialog.getByLabel("Issue Description").click();
    await page.keyboard.insertText(manualDescription);
    if (process.env.RUDDER_CAPTURE_AGENT_ISSUE_SCREENSHOTS === "1") {
      await page.waitForTimeout(400);
      await page.screenshot({ path: screenshotPath("shared-manual-issue-dialog.png"), fullPage: false });
    }

    await dialog.getByRole("tab", { name: "Agent", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Deferred Builder" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: project.name })).toBeVisible();
    await expect(dialog.getByLabel("Issue Description")).toContainText(manualDescription);
    await dialog.getByRole("button", { name: "Deferred Builder" }).click();
    await dialog.getByPlaceholder("Search Agents...").fill("Alternate Builder");
    await page.locator("[data-inline-entity-option]").filter({ hasText: "Alternate Builder" }).click();
    await expect(dialog.getByPlaceholder("Search Agents...")).toBeHidden();
    await dialog.getByRole("button", { name: project.name }).click();
    await dialog.getByPlaceholder("Search projects...").fill(alternateProject.name);
    await page.locator('[data-inline-entity-option]:visible').filter({ hasText: alternateProject.name }).click({ force: true });
    await expect(dialog.getByPlaceholder("Search projects...")).toBeHidden();
    await dialog.getByLabel("Issue Description").click();
    await page.keyboard.press("ControlOrMeta+A");
    const agentDescription = "Create an issue from the shared description after switching modes.";
    await page.keyboard.insertText(agentDescription);
    await dialog.getByRole("tab", { name: "Manual", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Alternate Builder" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: alternateProject.name })).toBeVisible();
    await expect(dialog.getByLabel("Issue Description")).toContainText(agentDescription);

    const manualResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/issues`)
      && response.ok(),
    );
    await dialog.getByRole("button", { name: "Create Issue" }).click();
    const manualIssue = await (await manualResponsePromise).json() as {
      assigneeAgentId: string | null;
      description: string | null;
      identifier: string | null;
      projectId: string | null;
      title: string;
    };
    expect(manualIssue).toMatchObject({
      assigneeAgentId: alternateAgent.id,
      description: agentDescription,
      projectId: alternateProject.id,
      title: manualTitle,
    });

    await openNewIssueDialog(page);
    const agentDialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(agentDialog).toBeVisible();
    await agentDialog.getByLabel("Issue Description").click();
    await page.keyboard.insertText(agentDescription);
    await agentDialog.getByRole("tab", { name: "Agent", exact: true }).click();
    await expect(agentDialog.getByRole("button", { name: "Alternate Builder" })).toBeVisible();
    await expect(agentDialog.getByRole("button", { name: alternateProject.name })).toBeVisible();
    await expect(agentDialog.getByLabel("Issue Description")).toContainText(agentDescription);
    if (process.env.RUDDER_CAPTURE_AGENT_ISSUE_SCREENSHOTS === "1") {
      await page.waitForTimeout(400);
      await page.screenshot({ path: screenshotPath("shared-agent-issue-dialog.png"), fullPage: false });
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileDialogBox = await agentDialog.boundingBox();
      expect(mobileDialogBox).not.toBeNull();
      expect(mobileDialogBox!.x).toBeGreaterThanOrEqual(0);
      expect(mobileDialogBox!.y).toBeGreaterThanOrEqual(0);
      expect(mobileDialogBox!.x + mobileDialogBox!.width).toBeLessThanOrEqual(390);
      expect(mobileDialogBox!.y + mobileDialogBox!.height).toBeLessThanOrEqual(844);
      await page.screenshot({ path: screenshotPath("shared-agent-issue-dialog-mobile.png"), fullPage: false });
      await page.setViewportSize({ width: 1280, height: 720 });
    }

    const agentRequestPromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/agent-issue-creation-requests`),
    );
    await agentDialog.getByRole("button", { name: "Send to Agent" }).click();
    const agentResponse = await agentRequestPromise;
    expect(agentResponse.status()).toBe(202);
    const agentRequest = await agentResponse.json() as {
      agentId: string;
      instruction: string;
      projectId: string | null;
      status: string;
    };
    expect(agentRequest).toMatchObject({
      agentId: alternateAgent.id,
      instruction: agentDescription,
      projectId: alternateProject.id,
      status: "deferred",
    });
    await expect(agentDialog).toBeHidden();
    await expect(page.getByText("Sent to Agent. You'll be notified in Inbox when it's done.", { exact: true })).toBeVisible();

    await openNewIssueDialog(page);
    const reopenedDialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(reopenedDialog.getByRole("tab", { name: "Manual", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(reopenedDialog.getByLabel("Issue Description")).toHaveText("");

    const manualDraftDescription = "Manual draft preserved across an ordinary close.";
    await reopenedDialog.getByLabel("Issue Description").click();
    await page.keyboard.insertText(manualDraftDescription);
    await expect.poll(async () => page.evaluate(() => localStorage.getItem("rudder:issue-autosave")))
      .not.toBeNull();
    await reopenedDialog.getByRole("button", { name: "Close new issue dialog" }).click();
    await openNewIssueDialog(page);
    const restoredManualDialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(restoredManualDialog.getByLabel("Issue Description")).toContainText(manualDraftDescription);

    await restoredManualDialog.getByRole("tab", { name: "Agent", exact: true }).click();
    await restoredManualDialog.getByLabel("Issue Description").click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("Agent request discarded by ordinary close.");
    await restoredManualDialog.getByRole("button", { name: "Close new issue dialog" }).click();
    await openNewIssueDialog(page);
    const cleanReopenDialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(cleanReopenDialog.getByRole("tab", { name: "Manual", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(cleanReopenDialog.getByLabel("Issue Description")).toHaveText("");
  });
});

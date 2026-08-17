import { expect, test, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

async function createOrganization(page: Page, name: string) {
  const response = await page.request.post("/api/orgs", { data: { name } });
  expect(response.ok()).toBe(true);
  return response.json();
}

test("shows request origins and asks for a reason only after Reject", async ({ page }, testInfo) => {
  const organization = await createOrganization(page, `Messenger-Request-Decisions-${Date.now()}`);
  const agent = await createE2EChatAgent(page.request, organization.id, { name: "Request Source Agent" });
  const chatResponse = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Create an operations agent",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      initialMessage: { body: "Create an agent from this Chat context." },
    },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json();

  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Create a release agent",
      description: "This Issue is the source of the hire request.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueResponse.ok()).toBe(true);
  const issue = await issueResponse.json();

  const chatApprovalResponse = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
    data: {
      type: "hire_agent",
      payload: {
        name: "Operations Agent",
        role: "general",
        chatConversationId: chat.id,
      },
    },
  });
  expect(chatApprovalResponse.ok()).toBe(true);
  const chatApproval = await chatApprovalResponse.json();

  const issueApprovalResponse = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
    data: {
      type: "hire_agent",
      payload: {
        name: "Release Agent",
        role: "devops",
      },
      issueIds: [issue.id],
    },
  });
  expect(issueApprovalResponse.ok()).toBe(true);
  const issueApproval = await issueApprovalResponse.json();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/approvals`, { waitUntil: "commit" });

  const chatCard = page.getByTestId(`messenger-approval-card-${chatApproval.id}`);
  const issueCard = page.getByTestId(`messenger-approval-card-${issueApproval.id}`);
  await expect(chatCard).toBeVisible({ timeout: 15_000 });
  await expect(issueCard).toBeVisible();
  await expect(chatCard.getByTestId("approval-origin-link")).toContainText("Create an operations agent");
  await expect(issueCard.getByTestId("approval-origin-link")).toContainText(`${issue.identifier} · Create a release agent`);
  await expect(page.getByText("Open full approval", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Request changes", { exact: true })).toHaveCount(0);

  const [iconBox, titleBox] = await Promise.all([
    issueCard.getByTestId("approval-type-icon").boundingBox(),
    issueCard.getByTestId("approval-title-row").boundingBox(),
  ]);
  expect(iconBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  const iconCenter = iconBox!.y + iconBox!.height / 2;
  const titleCenter = titleBox!.y + titleBox!.height / 2;
  expect(Math.abs(iconCenter - titleCenter)).toBeLessThanOrEqual(1);

  await chatCard.getByTestId("approval-origin-link").click();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));
  await page.goto(`/${organization.issuePrefix}/messenger/approvals`, { waitUntil: "commit" });

  let currentIssueCard = page.getByTestId(`messenger-approval-card-${issueApproval.id}`);
  await currentIssueCard.getByTestId("approval-origin-link").click();
  await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier}$`));
  await page.goto(`/${organization.issuePrefix}/messenger/approvals`, { waitUntil: "commit" });

  currentIssueCard = page.getByTestId(`messenger-approval-card-${issueApproval.id}`);
  await currentIssueCard.getByRole("button", { name: "Reject" }).click();
  const rejectDialog = page.getByTestId("approval-reject-dialog");
  await expect(rejectDialog).toBeVisible();
  await expect(rejectDialog.getByText("0/500", { exact: true })).toBeVisible();
  await rejectDialog.getByTestId("approval-rejection-reason").fill("The requested role needs a narrower operating scope.");
  await page.screenshot({ path: testInfo.outputPath("messenger-request-reject-dialog-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(rejectDialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("messenger-request-reject-dialog-narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await rejectDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(rejectDialog).toHaveCount(0);

  const pendingState = await page.request.get(`/api/approvals/${issueApproval.id}`).then((response) => response.json());
  expect(pendingState.status).toBe("pending");
  await currentIssueCard.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByTestId("approval-rejection-reason")).toHaveValue("");
  await page.getByTestId("approval-rejection-reason").fill("The requested role needs a narrower operating scope.");
  await rejectDialog.getByRole("button", { name: "Reject" }).click();

  await expect.poll(async () => {
    const response = await page.request.get(`/api/approvals/${issueApproval.id}`);
    const approval = await response.json();
    return { status: approval.status, decisionNote: approval.decisionNote };
  }).toEqual({
    status: "rejected",
    decisionNote: "The requested role needs a narrower operating scope.",
  });

  await expect(rejectDialog).toHaveCount(0);
  await expect(currentIssueCard).toContainText("The requested role needs a narrower operating scope.");
  await page.screenshot({ path: testInfo.outputPath("messenger-request-decisions-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(currentIssueCard).toBeVisible();
  await expect(currentIssueCard.getByTestId("approval-origin-link")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("messenger-request-decisions-narrow.png"), fullPage: true });
});

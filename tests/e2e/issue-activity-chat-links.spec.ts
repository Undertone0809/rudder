import { expect, test } from "@playwright/test";

const ORG_NAME = `Issue-Activity-${Date.now()}`;

test.describe("Issue activity chat links", () => {
  test("shows chat conversations that created or linked an issue", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: ORG_NAME },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const linkedIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue linked from chat",
        description: "Track chat-linked issue activity.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(linkedIssueRes.ok()).toBe(true);
    const linkedIssue = await linkedIssueRes.json();

    const linkedChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Debug thread",
        contextLinks: [{ entityType: "issue", entityId: linkedIssue.id }],
      },
    });
    expect(linkedChatRes.ok()).toBe(true);

    const conversionChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: { title: "Customer escalation" },
    });
    expect(conversionChatRes.ok()).toBe(true);
    const conversionChat = await conversionChatRes.json();

    const convertedIssueRes = await page.request.post(`/api/chats/${conversionChat.id}/convert-to-issue`, {
      data: {
        proposal: {
          title: "Issue converted from chat",
          description: "Track issue conversion activity.",
          priority: "medium",
        },
      },
    });
    expect(convertedIssueRes.ok()).toBe(true);
    const convertedPayload = await convertedIssueRes.json();
    const convertedIssue = convertedPayload.issue;

    await page.goto(`/issues/${linkedIssue.identifier ?? linkedIssue.id}`);
    await expect(page.getByRole("tab", { name: "Activity" })).toBeVisible();
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByRole("link", { name: "Debug thread" })).toBeVisible();
    await expect(page.getByText("with this issue linked", { exact: false })).toBeVisible();

    await page.goto(`/issues/${convertedIssue.identifier ?? convertedIssue.id}`);
    await expect(page.getByRole("tab", { name: "Activity" })).toBeVisible();
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByRole("link", { name: "Customer escalation" })).toBeVisible();
    await expect(page.getByText("created this issue from", { exact: false })).toBeVisible();
  });
});

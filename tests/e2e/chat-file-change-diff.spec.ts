import { expect, test, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_APP_SERVER_STUB } from "./support/e2e-env";

const AUDIT_PATH = "/workspace/src/audit-log.ts";
const INVOICE_PATH = "/workspace/src/InvoicePanel.tsx";

async function expandFileChanges(page: Page) {
  const transcript = page.getByTestId("chat-transcript-item");
  await transcript.getByRole("button", { name: /Worked for/i }).click();
  await transcript.getByRole("button", { name: "Expand tool details: Edited 2 files" }).click();
  return transcript;
}

test("keeps App Server file patches attached to their corresponding Messenger rows", async ({ page }) => {
  test.setTimeout(120_000);
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-File-Diff-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; urlKey: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "File Diff Agent",
    agentRuntimeConfig: {
      model: "gpt-5.4",
      command: E2E_CODEX_APP_SERVER_STUB,
      chatAppServerEnabled: true,
    },
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${agent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Show two historical file diffs");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
    "The two file changes are ready for review.",
    { timeout: 20_000 },
  );

  let transcript = await expandFileChanges(page);
  const auditTarget = transcript.locator(`[data-transcript-diff-target="${AUDIT_PATH}"]`);
  const invoiceTarget = transcript.locator(`[data-transcript-diff-target="${INVOICE_PATH}"]`);
  await expect(auditTarget).toContainText("audit-log.ts +2 -0");
  await expect(invoiceTarget).toContainText("InvoicePanel.tsx +1 -1");

  await auditTarget.click();
  const auditDiff = transcript.getByRole("region", { name: "Historical diff for audit-log.ts" });
  await expect(auditDiff).toContainText('auditMode = "strict"');
  await expect(auditDiff).toContainText("retainDays = 30");
  await expect(auditDiff).not.toContainText("Ready for review");
  await expect(auditDiff).not.toContainText('"changes"');
  await auditTarget.click();
  await expect(auditDiff).toBeHidden();

  await invoiceTarget.click();
  const invoiceDiff = transcript.getByRole("region", { name: "Historical diff for InvoicePanel.tsx" });
  await expect(invoiceDiff).toContainText("Draft");
  await expect(invoiceDiff).toContainText("Ready for review");
  await expect(invoiceDiff).not.toContainText("auditMode");
  await expect(invoiceDiff).not.toContainText('"changes"');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(async () => {
    transcript = await expandFileChanges(page);
    await expect(transcript.locator(`[data-transcript-diff-target="${AUDIT_PATH}"]`)).toContainText(
      "audit-log.ts +2 -0",
      { timeout: 1_000 },
    );
    await expect(transcript.locator(`[data-transcript-diff-target="${INVOICE_PATH}"]`)).toContainText(
      "InvoicePanel.tsx +1 -1",
      { timeout: 1_000 },
    );
  }).toPass({ timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});


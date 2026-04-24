import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { E2E_BIN_DIR } from "./support/e2e-env";

async function writeProposalStub(
  name: string,
  result: {
    kind: "issue_proposal";
    body: string;
    structuredPayload: {
      issueProposal: {
        title: string;
        description: string;
        priority: string;
      };
    };
  },
) {
  await fs.mkdir(E2E_BIN_DIR, { recursive: true });
  const stubPath = path.join(E2E_BIN_DIR, `${name}.js`);
  const stubSource = `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", async () => {
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const result = ${JSON.stringify(result)};
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-proposal", model: "gpt-5.4" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: result.body + "\\n" + sentinel + JSON.stringify(result),
    },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  }) + "\\n");
});
`;
  await fs.writeFile(stubPath, stubSource, "utf8");
  await fs.chmod(stubPath, 0o755);
  return stubPath;
}

async function createProposalOrg(page: Page, name: string, command: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
        command,
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  return organization;
}

test.describe("Chat proposal review block", () => {
  test("keeps decision note inside the review block and restores the composer after rejection", async ({ page }) => {
    const command = await writeProposalStub("proposal-review-reject", {
      kind: "issue_proposal",
      body: "Create a scoped issue for this review-block test.",
      structuredPayload: {
        issueProposal: {
          title: "Review block rejection test",
          description: "Verify review note placement and rejection state styling for chat issue proposals.",
          priority: "low",
        },
      },
    });
    await createProposalOrg(page, `Reject-${Date.now()}`, command);

    await page.goto("/chat");
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft an issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");
    await expect(reviewBlock.getByTestId("proposal-review-note")).toBeVisible();
    await expect(page.getByTestId("proposal-review-gate")).toHaveCount(0);
    await expect(page.getByPlaceholder("Ask anything")).toHaveCount(0);

    await reviewBlock.getByTestId("proposal-review-note").fill("Need a concrete execution scope before opening this.");
    await reviewBlock.getByRole("button", { name: "Reject" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "rejected", { timeout: 15_000 });
    await expect(reviewBlock.getByTestId("proposal-review-status")).toContainText("rejected");
    await expect(reviewBlock).toContainText("Rejected. This proposal will not move forward.");
    await expect(reviewBlock).toContainText("Need a concrete execution scope before opening this.");
    await expect(page.getByTestId("proposal-review-gate")).toHaveCount(0);
    await expect(page.locator(".rudder-mdxeditor-content").last()).toBeVisible();
  });

  test("shows approved proposals as completed review blocks", async ({ page }) => {
    const command = await writeProposalStub("proposal-review-approve", {
      kind: "issue_proposal",
      body: "Create a scoped issue for this approval-state test.",
      structuredPayload: {
        issueProposal: {
          title: "Review block approval test",
          description: "Verify approved chat proposals remain visible as completed review blocks.",
          priority: "medium",
        },
      },
    });
    await createProposalOrg(page, `Approve-${Date.now()}`, command);

    await page.goto("/chat");
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft another issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");

    await reviewBlock.getByRole("button", { name: "Approve" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    await expect(reviewBlock.getByTestId("proposal-review-status")).toContainText("approved");
    await expect(reviewBlock).toContainText("Approved. This proposal has been accepted.");
    await expect(page.getByTestId("proposal-review-gate")).toHaveCount(0);
    await expect(page.locator(".rudder-mdxeditor-content").last()).toBeVisible();
  });
});

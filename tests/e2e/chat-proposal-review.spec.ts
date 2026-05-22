import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
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
        assigneeAgentId?: string;
        assigneeUserId?: string;
        reviewerAgentId?: string;
        reviewerUserId?: string;
      };
      planDocument?: {
        title: string;
        body: string;
        changeSummary?: string;
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
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Proposal Agent",
    command,
  });
  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  return { ...organization, chatAgent };
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
    const organization = await createProposalOrg(page, `Reject-${Date.now()}`, command);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft an issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");
    await expect(reviewBlock).toHaveAttribute("data-kind", "issue");
    await expect(reviewBlock).toContainText("Issue proposal");
    await expect(reviewBlock).toContainText("Proposed issue");
    await expect(reviewBlock).toContainText("Priority");
    await expect(reviewBlock).not.toContainText("Draft issue awaiting review");
    await expect(reviewBlock).not.toContainText("Review this proposal here before continuing the conversation.");
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
          description: [
            "## Execution plan",
            "",
            "- Render the issue proposal description with markdown.",
            "- Keep the review block visible after approval.",
            "",
            "Run `pnpm test:e2e` before landing.",
          ].join("\n"),
          priority: "medium",
        },
      },
    });
    const organization = await createProposalOrg(page, `Approve-${Date.now()}`, command);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft another issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");
    await expect(reviewBlock.locator("h2")).toHaveText("Execution plan");
    await expect(reviewBlock.locator("ul li")).toHaveCount(2);
    await expect(reviewBlock.locator("code")).toContainText("pnpm test:e2e");

    await reviewBlock.getByRole("button", { name: "Approve" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    await expect(reviewBlock.getByTestId("proposal-review-status")).toContainText("approved");
    await expect(reviewBlock).toContainText("Approved. This proposal has been accepted.");
    const createdIssueLink = page.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });
    await expect(createdIssueLink).toHaveAttribute("href", /\/issues\//);
    await createdIssueLink.click();
    await expect(page.getByRole("heading", { name: "Review block approval test" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("proposal-review-gate")).toHaveCount(0);
    await expect(page.locator(".rudder-mdxeditor-content").last()).toBeVisible();
  });

  test("preserves explicit assignees on approved chat-created issues", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Assign-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Proposal Owner",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();
    const command = await writeProposalStub("proposal-review-assignee", {
      kind: "issue_proposal",
      body: "Create a scoped issue for the selected chat agent.",
      structuredPayload: {
        issueProposal: {
          title: "Selected chat agent assignment test",
          description: "Verify approved chat issue proposals preserve explicit assignment.",
          priority: "medium",
          assigneeAgentId: agent.id,
        },
      },
    });
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Proposal Agent",
      command,
    });
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    const conversationRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Selected agent proposal",
        preferredAgentId: chatAgent.id,
        issueCreationMode: "manual_approval",
      },
    });
    expect(conversationRes.ok()).toBe(true);
    const conversation = await conversationRes.json();

    await page.goto(`/chat/${conversation.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft an owned issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");
    await reviewBlock.getByRole("button", { name: "Approve" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    const createdIssueLink = page.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });
    await createdIssueLink.click();
    await expect(page.getByRole("heading", { name: "Selected chat agent assignment test" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Proposal Owner").first()).toBeVisible({ timeout: 15_000 });
  });

  test("shows reviewer metadata on chat issue proposals and preserves it after approval", async ({ page }) => {
    const command = await writeProposalStub("proposal-reviewer-metadata", {
      kind: "issue_proposal",
      body: "Create a scoped issue with a reviewer.",
      structuredPayload: {
        issueProposal: {
          title: "Reviewer metadata proposal test",
          description: "Verify chat issue proposals can carry reviewer metadata.",
          priority: "medium",
        },
      },
    });
    const organization = await createProposalOrg(page, `Reviewer-${Date.now()}`, command);
    await writeProposalStub("proposal-reviewer-metadata", {
      kind: "issue_proposal",
      body: "Create a scoped issue with a reviewer.",
      structuredPayload: {
        issueProposal: {
          title: "Reviewer metadata proposal test",
          description: "Verify chat issue proposals can carry reviewer metadata.",
          priority: "medium",
          reviewerAgentId: organization.chatAgent.id,
        },
      },
    });

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft a reviewed issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toContainText("Reviewer · Proposal Agent");
    await reviewBlock.getByRole("button", { name: "Approve" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    const createdIssueLink = page.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });
    await createdIssueLink.click();
    await expect(page.getByRole("heading", { name: "Reviewer metadata proposal test" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Proposal Agent").first()).toBeVisible({ timeout: 15_000 });
  });

  test("keeps plan-mode proposals pending until approval and writes the plan document", async ({ page }) => {
    const command = await writeProposalStub("proposal-review-plan-mode", {
      kind: "issue_proposal",
      body: "I drafted the plan and issue proposal for approval.",
      structuredPayload: {
        issueProposal: {
          title: "Plan mode approval test",
          description: "Create the issue only after the operator approves the plan-mode proposal.",
          priority: "high",
        },
        planDocument: {
          title: "Plan-mode rollout plan",
          body: ["## Scope", "", "- Draft first", "- Create after approval"].join("\n"),
          changeSummary: "Created from approved plan-mode proposal",
        },
      },
    });
    const organization = await createProposalOrg(page, "PlanMode-" + Date.now(), command);
    const conversationRes = await page.request.post("/api/orgs/" + organization.id + "/chats", {
      data: {
        title: "Plan mode gated proposal",
        preferredAgentId: organization.chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: true,
      },
    });
    expect(conversationRes.ok()).toBe(true);
    const conversation = await conversationRes.json();

    await page.goto("/chat/" + conversation.id);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please plan and propose the issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");
    await expect(reviewBlock).toContainText("Plan-mode rollout plan");
    await expect(reviewBlock.locator("h2")).toHaveText("Scope");
    await expect(page.locator(".chat-system-issue-link")).toHaveCount(0);

    await reviewBlock.getByRole("button", { name: "Approve" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    const createdIssueLink = page.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });
    await createdIssueLink.click();
    await expect(page.getByRole("heading", { name: "Plan mode approval test" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Plan-mode rollout plan")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Draft first")).toBeVisible({ timeout: 15_000 });
  });

});

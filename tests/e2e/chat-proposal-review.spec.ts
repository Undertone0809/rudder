import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_BIN_DIR } from "./support/e2e-env";

async function selectInlineEntityOption(page: Page, name: string) {
  const popover = page.locator(".motion-inline-selector-pop:visible").last();
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name }).click();
}

async function writeProposalStub(
  name: string,
  result: {
    kind: "issue_proposal";
    body: string;
    structuredPayload: {
      issueProposal: {
        title: string;
        description: string;
        status?: string;
        priority: string;
        assigneeAgentId?: string | null;
        assigneeUserId?: string | null;
        assigneeUnassignedReason?: string | null;
        reviewerAgentId?: string;
        reviewerUserId?: string;
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
  test("collapses long proposal details until the operator expands them", async ({ page }) => {
    const command = await writeProposalStub("proposal-review-long-details", {
      kind: "issue_proposal",
      body: "Create a long proposal for the details expansion test.",
      structuredPayload: {
        issueProposal: {
          title: "Long proposal details test",
          description: [
            "Purpose: Verify long proposal details start collapsed.",
            "Background: This text is intentionally long enough to exceed the ten-line preview area.",
            "Scope:",
            "- Confirm the first bullet renders in the preview.",
            "- Confirm the second bullet renders in the preview.",
            "- Confirm the third bullet renders in the preview.",
            "- Confirm the fourth bullet renders below the fold.",
            "- Confirm the fifth bullet renders below the fold.",
            "- Confirm the sixth bullet renders below the fold.",
            "- Confirm the seventh bullet renders below the fold.",
            "- Confirm the eighth bullet renders below the fold.",
            "- Confirm the ninth bullet renders below the fold.",
            "- Confirm the tenth bullet renders below the fold.",
            "Acceptance: Clicking show full proposal reveals every line without clipping.",
          ].join("\n"),
          priority: "medium",
          assigneeUnassignedReason: "This proposal is intentionally unassigned while the operator reviews the long details.",
        },
      },
    });
    const organization = await createProposalOrg(page, `LongDetails-${Date.now()}`, command);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft a long issue proposal");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toContainText("Reason: This proposal is intentionally unassigned while the operator reviews the long details.");
    const details = reviewBlock.locator(".chat-review-details-body");
    const expandButton = reviewBlock.getByRole("button", { name: "Show full proposal" });
    await expect(expandButton).toBeVisible();
    await expect(details).toHaveClass(/chat-review-details-body--collapsed/);
    await expect
      .poll(async () =>
        details.evaluate((element) => {
          const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
          return {
            clipped: element.scrollHeight > element.clientHeight + 1,
            visibleLines: Math.round(element.clientHeight / lineHeight),
          };
        }),
      )
      .toEqual({ clipped: true, visibleLines: 10 });

    await expandButton.click();

    await expect(reviewBlock.getByRole("button", { name: "Show less" })).toBeVisible();
    await expect
      .poll(async () =>
        details.evaluate((element) => ({
          expanded: element.scrollHeight <= element.clientHeight + 1,
          collapsed: element.classList.contains("chat-review-details-body--collapsed"),
          fadeVisible: element.classList.contains("chat-review-details-body--can-expand"),
        })),
      )
      .toEqual({ expanded: true, collapsed: false, fadeVisible: false });
  });

  test("keeps decision note inside the review block and restores the composer after rejection", async ({ page }) => {
    const command = await writeProposalStub("proposal-review-reject", {
      kind: "issue_proposal",
      body: "Create a scoped issue for this review-block test.",
      structuredPayload: {
        issueProposal: {
          title: "Review block rejection test",
          description: "Verify review note placement and rejection state styling for chat issue proposals.",
          priority: "low",
          assigneeUnassignedReason: "This proposal is intentionally unassigned until the rejection flow completes.",
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
    await expect(reviewBlock).toContainText("Priority");
    await expect(reviewBlock).not.toContainText("Proposed issue");
    await expect(reviewBlock).not.toContainText("Issue description");
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
          assigneeUnassignedReason: "This proposal is intentionally unassigned for the approval state test.",
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

    await reviewBlock.getByTestId("proposal-review-approve").click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    await expect(reviewBlock.getByTestId("proposal-review-status")).toContainText("approved");
    await expect(reviewBlock).toContainText("Approved. This proposal has been accepted.");
    const createdIssueLink = page.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });
    await expect(createdIssueLink).toHaveAttribute("href", /\/issues\//);
    await expect(page.locator(".chat-composer").last()).toBeVisible();
    const composerGap = await page.evaluate(() => {
      const scrollRegion = document.querySelector('[data-testid="chat-messages-scroll-region"]');
      const messagesLayout = scrollRegion?.parentElement;
      const messagesContent = document.querySelector('[data-testid="chat-messages-content"]');
      const composers = Array.from(document.querySelectorAll(".chat-composer"));
      const composer = composers.at(-1);
      if (!scrollRegion || !messagesLayout || !messagesContent || !composer) return null;

      const scrollBox = scrollRegion.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      return {
        outerGap: Math.round(composerBox.top - scrollBox.bottom),
        layoutRowGap: window.getComputedStyle(messagesLayout).rowGap,
        contentPaddingBottom: window.getComputedStyle(messagesContent).paddingBottom,
      };
    });
    expect(composerGap).not.toBeNull();
    expect(composerGap!.outerGap).toBeGreaterThanOrEqual(-1);
    expect(composerGap!.outerGap).toBeLessThanOrEqual(1);
    expect(["normal", "0px"]).toContain(composerGap!.layoutRowGap);
    expect(composerGap!.contentPaddingBottom).toBe("0px");
    await createdIssueLink.click();
    await expect(page.getByRole("heading", { name: "Review block approval test" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("proposal-review-gate")).toHaveCount(0);
    await expect(page.locator(".chat-composer").last()).toBeVisible();
    await expect(page.getByRole("button", { name: "Comment" })).toBeVisible();
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

  test("creates approved proposals as todo when no initial status is declared", async ({ page }) => {
    const command = await writeProposalStub("proposal-review-default-todo", {
      kind: "issue_proposal",
      body: "Create a runnable issue for approval.",
      structuredPayload: {
        issueProposal: {
          title: "Default todo proposal status test",
          description: "Verify approved chat issue proposals default to To Do.",
          priority: "medium",
          assigneeUnassignedReason: "The operator will choose an owner during approval.",
        },
      },
    });
    const organization = await createProposalOrg(page, `DefaultTodo-${Date.now()}`, command);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft a runnable issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toContainText("todo");
    await reviewBlock.getByRole("button", { name: "Approve" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    const createdIssueLink = page.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });
    await createdIssueLink.click();
    await expect(page.getByRole("heading", { name: "Default todo proposal status test" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("todo").first()).toBeVisible({ timeout: 15_000 });

    const issuesRes = await page.request.get(`/api/orgs/${organization.id}/issues`);
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    expect(issues.find((issue: { title: string }) => issue.title === "Default todo proposal status test")?.status).toBe("todo");
  });

  test("lets operators edit proposal status and priority before approval", async ({ page }) => {
    const command = await writeProposalStub("proposal-review-edit-status-priority", {
      kind: "issue_proposal",
      body: "Create a runnable issue with operator-selected status and priority.",
      structuredPayload: {
        issueProposal: {
          title: "Editable proposal metadata test",
          description: "Verify status and priority edits are used when approving a chat issue proposal.",
          priority: "medium",
          assigneeUnassignedReason: "The operator will choose an owner after the issue is created.",
        },
      },
    });
    const organization = await createProposalOrg(page, `EditableMetadata-${Date.now()}`, command);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft an issue whose status I can tune");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");
    await expect(reviewBlock).toContainText("todo");

    await reviewBlock.getByRole("button", { name: "Edit status" }).click();
    await page.getByRole("menuitem", { name: /in review/i }).click();
    await expect(reviewBlock).toContainText("in review");

    await reviewBlock.getByRole("button", { name: /Edit priority/i }).click();
    await page.getByRole("menuitemradio", { name: /High/i }).click();
    await expect(reviewBlock).toContainText("High");

    await reviewBlock.getByRole("button", { name: "Approve" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    const createdIssueLink = page.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });

    const issuesRes = await page.request.get(`/api/orgs/${organization.id}/issues`);
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    const createdIssue = issues.find((issue: { title: string }) => issue.title === "Editable proposal metadata test");
    expect(createdIssue?.status).toBe("in_review");
    expect(createdIssue?.priority).toBe("high");
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
          assigneeUnassignedReason: "This proposal is intentionally unassigned while reviewer metadata is inspected.",
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
          assigneeUnassignedReason: "This proposal is intentionally unassigned while reviewer metadata is inspected.",
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

  test("lets operators edit proposal owner and reviewer before approval", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `EditableProposal-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const ownerRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Editable Owner",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
    });
    expect(ownerRes.ok()).toBe(true);
    const owner = await ownerRes.json();
    const reviewerRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Editable Reviewer",
        role: "cto",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
    });
    expect(reviewerRes.ok()).toBe(true);
    const reviewer = await reviewerRes.json();
    const command = await writeProposalStub("proposal-review-edit-principals", {
      kind: "issue_proposal",
      body: "Create a scoped issue and let the operator tune routing before approval.",
      structuredPayload: {
        issueProposal: {
          title: "Editable proposal principals test",
          description: "Verify owner and reviewer edits are used when approving a chat issue proposal.",
          priority: "medium",
          assigneeUnassignedReason: "The operator will choose the owner before approving.",
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
        title: "Editable principals proposal",
        preferredAgentId: chatAgent.id,
        issueCreationMode: "manual_approval",
      },
    });
    expect(conversationRes.ok()).toBe(true);
    const conversation = await conversationRes.json();

    await page.goto(`/chat/${conversation.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft an editable routing issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");
    await reviewBlock.getByRole("button", { name: "Edit owner" }).click();
    await selectInlineEntityOption(page, "Editable Owner");
    await reviewBlock.getByRole("button", { name: "Edit reviewer" }).click();
    await selectInlineEntityOption(page, "Editable Reviewer");
    await expect(reviewBlock).toContainText("Editable Owner");
    await expect(reviewBlock).toContainText("Editable Reviewer");

    await reviewBlock.getByRole("button", { name: "Approve" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    const createdIssueLink = page.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });
    await createdIssueLink.click();
    await expect(page.getByRole("heading", { name: "Editable proposal principals test" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(owner.name).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(reviewer.name).first()).toBeVisible({ timeout: 15_000 });
  });

  test("keeps plan-mode proposals pending until approval without a plan document", async ({ page }) => {
    const command = await writeProposalStub("proposal-review-plan-mode", {
      kind: "issue_proposal",
      body: "I drafted the plan and issue proposal for approval.",
      structuredPayload: {
        issueProposal: {
          title: "Plan mode approval test",
          description: "Create the issue only after the operator approves the plan-mode proposal.",
          priority: "high",
          assigneeUnassignedReason: "Plan mode defers owner selection until the operator approves the plan.",
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
    await expect(reviewBlock).toBeVisible({ timeout: 30_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");
    await expect(reviewBlock).toContainText("Plan mode approval test");
    await expect(reviewBlock).toContainText("Create the issue only after the operator approves the plan-mode proposal.");
    await expect(page.locator(".chat-system-issue-link")).toHaveCount(0);

    await reviewBlock.getByRole("button", { name: "Approve" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    const createdIssueLink = page.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });
    await createdIssueLink.click();
    await expect(page.getByRole("heading", { name: "Plan mode approval test" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Create the issue only after the operator approves the plan-mode proposal.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Plan-mode rollout plan")).toHaveCount(0);
    await expect(page.getByText("Draft first")).toHaveCount(0);
  });

});

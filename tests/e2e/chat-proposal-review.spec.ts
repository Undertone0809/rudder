import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_BIN_DIR } from "./support/e2e-env";

async function selectInlineEntityOption(page: Page, name: string) {
  const popover = page.locator(".motion-inline-selector-pop:visible").last();
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name }).click();
  await expect(page.locator(".motion-inline-selector-pop:visible")).toHaveCount(0);
}

async function createSkill(request: APIRequestContext, orgId: string, name: string, slug: string) {
  const skillRes = await request.post(`/api/orgs/${orgId}/skills`, {
    data: {
      name,
      slug,
      markdown: `---\nname: ${name}\n---\n\n# ${name}\n`,
    },
  });
  expect(skillRes.ok()).toBe(true);
  return skillRes.json();
}

async function syncAgentSkills(
  request: APIRequestContext,
  agentId: string,
  orgId: string,
  desiredSkills: string[],
) {
  const syncRes = await request.post(`/api/agents/${agentId}/skills/sync?orgId=${encodeURIComponent(orgId)}`, {
    data: { desiredSkills },
  });
  expect(syncRes.ok()).toBe(true);
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

async function writeOriginalImageProposalStub(name: string) {
  await fs.mkdir(E2E_BIN_DIR, { recursive: true });
  const stubPath = path.join(E2E_BIN_DIR, `${name}.js`);
  const stubSource = `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const evidencePath = prompt.match(/"name":\\s*"proposal-evidence\\.png"[\\s\\S]{0,320}?"contentPath":\\s*"([^"]+)"/)?.[1] ?? null;
  const isRevision = prompt.includes("Retain the relevant original image and narrow the acceptance wording.");
  const hasPromptContract = prompt.includes("For initial and revised issue proposals")
    && prompt.includes("canonical contentPath")
    && prompt.includes("localPath is temporary runtime inspection context only")
    && prompt.includes("do not copy every attachment indiscriminately")
    && (!isRevision || prompt.includes("re-check relevant user image attachments across the available recentMessages history"));
  const imageMarkdown = evidencePath ? "![Original issue evidence](" + evidencePath + ")" : "";
  const description = hasPromptContract && evidencePath
    ? [
        isRevision ? "## Revised proposal" : "## Initial proposal",
        "",
        isRevision
          ? "Keep the source screenshot and narrow acceptance to the observed state."
          : "Use the operator's source screenshot as the requirement and acceptance reference.",
        "",
        imageMarkdown,
      ].join("\\n")
    : "Prompt contract or canonical image evidence is missing.";
  const result = {
    kind: "issue_proposal",
    body: isRevision ? "I revised the proposal and retained the original evidence." : "I drafted the proposal with the original evidence.",
    structuredPayload: {
      issueProposal: {
        title: "Original image proposal test",
        description,
        priority: "medium",
        assigneeUnassignedReason: "The operator will choose an owner after reviewing the preserved evidence.",
      },
    },
  };
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-original-image-proposal", model: "gpt-5.4" }) + "\\n");
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

async function proposalEvidenceScreenshotPath(testInfo: TestInfo, filename: string) {
  const evidenceDir = process.env.RUDDER_R6Z27_SCREENSHOT_DIR?.trim();
  if (!evidenceDir) return testInfo.outputPath(filename);
  await fs.mkdir(evidenceDir, { recursive: true });
  return path.join(evidenceDir, filename);
}

test.describe("Chat proposal review block", () => {
  test("preserves a relevant original image across proposal revision and the created issue", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const command = await writeOriginalImageProposalStub("proposal-review-original-image");
    const organization = await createProposalOrg(page, `OriginalImage-${Date.now()}`, command);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles([
      {
        name: "proposal-evidence.png",
        mimeType: "image/png",
        buffer: await fs.readFile(path.resolve("ui/public/rudder-logo.png")),
      },
      {
        name: "unrelated-reference.png",
        mimeType: "image/png",
        buffer: await fs.readFile(path.resolve("ui/public/favicon-32x32.png")),
      },
    ]);
    await expect(page.getByTestId("chat-pending-image-attachment")).toHaveCount(2);
    await composer.fill("Please draft an issue proposal using the screenshot that shows the requirement.");
    await page.getByRole("button", { name: "Send" }).click();

    const initialReviewBlock = page.getByTestId("proposal-review-block").first();
    await expect(initialReviewBlock).toBeVisible({ timeout: 30_000 });
    await expect(initialReviewBlock).toHaveAttribute("data-status", "pending");
    await expect(initialReviewBlock.getByAltText("Original issue evidence")).toBeVisible();
    await expect(initialReviewBlock.getByAltText("unrelated-reference.png")).toHaveCount(0);
    await initialReviewBlock.getByRole("button", { name: "Show full proposal" }).click();
    const initialProposalPanel = page.getByTestId("chat-side-panel-issue-proposal-view");
    await expect(initialProposalPanel).toBeVisible();
    await expect(page.getByTestId("proposal-review-compact")).toBeVisible();
    const initialPanelReviewBlock = initialProposalPanel.getByTestId("proposal-review-block");
    await initialPanelReviewBlock.locator(".chat-review-details-body").screenshot({
      path: await proposalEvidenceScreenshotPath(testInfo, "initial-proposal-original-image.png"),
      animations: "disabled",
    });

    const chatId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;
    const messagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
    expect(messagesRes.ok()).toBe(true);
    const messages = await messagesRes.json();
    const originalUserMessage = messages.find((message: {
      role: string;
      attachments: Array<{ originalFilename: string | null }>;
    }) =>
      message.role === "user"
      && message.attachments.some((attachment) => attachment.originalFilename === "proposal-evidence.png"),
    );
    expect(originalUserMessage).toBeTruthy();
    const evidenceAttachment = originalUserMessage.attachments.find(
      (attachment: { originalFilename: string | null }) => attachment.originalFilename === "proposal-evidence.png",
    );
    const unrelatedAttachment = originalUserMessage.attachments.find(
      (attachment: { originalFilename: string | null }) => attachment.originalFilename === "unrelated-reference.png",
    );
    expect(evidenceAttachment?.contentPath).toMatch(/^\/api\/assets\/[^/]+\/content$/);
    expect(unrelatedAttachment?.contentPath).toMatch(/^\/api\/assets\/[^/]+\/content$/);

    const revisionFeedback = "Retain the relevant original image and narrow the acceptance wording.";
    await initialPanelReviewBlock
      .getByTestId("proposal-review-note")
      .locator(".rudder-mdxeditor-content[contenteditable='true']")
      .fill(revisionFeedback);
    await initialPanelReviewBlock.getByRole("button", { name: "Request changes" }).click();

    await expect(initialPanelReviewBlock).toHaveAttribute("data-status", "revision_requested", { timeout: 15_000 });
    const revisedReviewBlock = page
      .getByTestId("chat-messages-content")
      .getByTestId("proposal-review-block")
      .last();
    await expect(revisedReviewBlock).toHaveAttribute("data-status", "pending", { timeout: 30_000 });
    await expect(revisedReviewBlock.getByRole("heading", { name: "Revised proposal" })).toBeVisible();
    const revisedImage = revisedReviewBlock.getByAltText("Original issue evidence");
    await expect(revisedImage).toBeVisible();
    await expect(revisedImage).toHaveAttribute("src", evidenceAttachment.contentPath);
    await expect(revisedReviewBlock.locator(`img[src="${unrelatedAttachment.contentPath}"]`)).toHaveCount(0);
    await revisedReviewBlock.getByRole("button", { name: "Show full proposal" }).click();
    const revisedProposalPanel = page.getByTestId("chat-side-panel-issue-proposal-view");
    await expect(revisedProposalPanel).toBeVisible();
    await revisedProposalPanel.locator(".chat-review-details-body").screenshot({
      path: await proposalEvidenceScreenshotPath(testInfo, "revised-proposal-original-image.png"),
      animations: "disabled",
    });

    const revisedMessagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
    expect(revisedMessagesRes.ok()).toBe(true);
    const revisedMessages = await revisedMessagesRes.json();
    const proposalDescriptions = revisedMessages
      .filter((message: { kind: string }) => message.kind === "issue_proposal")
      .map((message: { structuredPayload?: { issueProposal?: { description?: string } } }) =>
        message.structuredPayload?.issueProposal?.description ?? "",
      );
    expect(proposalDescriptions).toHaveLength(2);
    expect(proposalDescriptions.every((description: string) =>
      description.includes(`![Original issue evidence](${evidenceAttachment.contentPath})`),
    )).toBe(true);
    expect(proposalDescriptions.join("\n")).not.toContain(unrelatedAttachment.contentPath);
    expect(proposalDescriptions.join("\n")).not.toContain("localPath");
    expect(proposalDescriptions.join("\n")).not.toContain("rudder-chat-attachments-");

    const revisedPanelReviewBlock = revisedProposalPanel.getByTestId("proposal-review-block");
    await revisedPanelReviewBlock.getByTestId("proposal-review-approve").click();
    await expect(revisedPanelReviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    const createdIssueLink = revisedPanelReviewBlock.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });
    await createdIssueLink.click();

    await expect(page.getByRole("heading", { name: "Original image proposal test" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Revised proposal" })).toBeVisible();
    const issueImage = page.getByAltText("Original issue evidence");
    await expect(issueImage).toBeVisible();
    await expect(issueImage).toHaveAttribute("src", evidenceAttachment.contentPath);
    await expect(page.locator(`img[src="${unrelatedAttachment.contentPath}"]`)).toHaveCount(0);

    const issuesRes = await page.request.get(`/api/orgs/${organization.id}/issues`);
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    const createdIssue = issues.find((issue: { title: string }) => issue.title === "Original image proposal test");
    expect(createdIssue?.description).toContain(`![Original issue evidence](${evidenceAttachment.contentPath})`);
    expect(createdIssue?.description).not.toContain(unrelatedAttachment.contentPath);
    expect(createdIssue?.description).not.toContain("localPath");
    expect(createdIssue?.description).not.toContain("rudder-chat-attachments-");
    await page.screenshot({
      path: await proposalEvidenceScreenshotPath(testInfo, "created-issue-original-image.png"),
      fullPage: true,
      animations: "disabled",
    });
  });

  test("opens long proposal details in a Side Panel tab and restores the inline card after close", async ({ page }, testInfo) => {
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

    const reviewBlock = page.locator(".chat-review-block--inline").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toContainText("Reason: This proposal is intentionally unassigned while the operator reviews the long details.");
    await page.screenshot({
      path: await proposalEvidenceScreenshotPath(testInfo, "issue-proposal-inline-card.png"),
      animations: "disabled",
      fullPage: true,
    });
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

    const compactProposal = page.getByTestId("proposal-review-compact");
    await expect(compactProposal).toBeVisible();
    await expect(reviewBlock).toHaveCount(0);
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveText("Issue proposal");
    await expect(sidePanel.getByRole("status")).toHaveText("Issue proposal opened in Side Panel.");
    const panelReviewBlock = sidePanel.getByTestId("proposal-review-block");
    const panelDetails = panelReviewBlock.locator(".chat-review-details-body");
    await expect
      .poll(async () =>
        panelDetails.evaluate((element) => ({
          expanded: element.scrollHeight <= element.clientHeight + 1,
          collapsed: element.classList.contains("chat-review-details-body--collapsed"),
          fadeVisible: element.classList.contains("chat-review-details-body--can-expand"),
        })),
      )
      .toEqual({ expanded: true, collapsed: false, fadeVisible: false });
    await expect(panelDetails).toContainText("Acceptance: Clicking show full proposal reveals every line without clipping.");
    await page.screenshot({
      path: await proposalEvidenceScreenshotPath(testInfo, "issue-proposal-side-panel.png"),
      animations: "disabled",
      fullPage: true,
    });

    await expect(compactProposal).toHaveAttribute("aria-expanded", "true");
    await compactProposal.click();
    await expect(sidePanel).toHaveCount(0);
    await expect(page.getByTestId("proposal-review-compact")).toHaveCount(0);
    const restoredReviewBlock = page.locator(".chat-review-block--inline").last();
    await expect(restoredReviewBlock).toBeVisible();
    await expect(restoredReviewBlock).toHaveClass(/chat-review-block--inline/);
    await page.screenshot({
      path: await proposalEvidenceScreenshotPath(testInfo, "issue-proposal-restored-card.png"),
      animations: "disabled",
      fullPage: true,
    });

    await restoredReviewBlock.getByRole("button", { name: "Show full proposal" }).click();
    const reopenedForHidePanel = page.getByTestId("chat-side-panel");
    const compactBeforeHide = page.getByTestId("proposal-review-compact");
    await expect(reopenedForHidePanel).toBeVisible();
    await expect(compactBeforeHide).toHaveAttribute("aria-expanded", "true");

    await reopenedForHidePanel.getByTestId("chat-side-panel-collapse").click();
    await expect(reopenedForHidePanel).toHaveCount(0);
    await expect(compactBeforeHide).toBeVisible();
    await expect(compactBeforeHide).toHaveAttribute("aria-expanded", "false");

    await compactBeforeHide.click();
    const reopenedPanel = page.getByTestId("chat-side-panel");
    await expect(reopenedPanel).toBeVisible();

    await reopenedPanel.getByTestId("chat-side-panel-add-tab").click();
    await expect(reopenedPanel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
    await reopenedPanel.getByTestId("chat-side-panel-empty-library-target").click();
    await expect(reopenedPanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
    await expect(reopenedPanel.getByRole("tab", { name: "Library" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const registeredCompactProposal = page.getByTestId("proposal-review-compact");
    await expect(registeredCompactProposal).toHaveAttribute("aria-expanded", "false");
    await registeredCompactProposal.click();
    await expect(reopenedPanel).toBeVisible();
    await expect(reopenedPanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
    await expect(registeredCompactProposal).toHaveAttribute("aria-expanded", "true");

    await registeredCompactProposal.click();
    await expect(reopenedPanel).not.toBeVisible();
    await expect(page.getByTestId("proposal-review-compact")).toHaveCount(0);
    await expect(page.locator(".chat-review-block--inline")).toHaveCount(1);

    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    const siblingPanel = page.getByTestId("chat-side-panel");
    await expect(siblingPanel).toBeVisible();
    await expect(siblingPanel.getByTestId("chat-side-panel-tab")).toHaveCount(1);
    await expect(siblingPanel.getByTestId("chat-side-panel-tab")).toContainText("Library");
    await siblingPanel.getByTestId("chat-side-panel-tab").hover();
    await siblingPanel.getByTestId("chat-side-panel-tab-close").click();

    await expect(siblingPanel).toHaveCount(0);
    await expect(page.getByTestId("proposal-review-compact")).toHaveCount(0);
    await expect(page.getByTestId("proposal-review-block")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Show full proposal" })).toBeVisible();
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
    await createSkill(page.request, organization.id, "Build Advisor", "build-advisor");
    await syncAgentSkills(page.request, organization.chatAgent.id, organization.id, ["build-advisor"]);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft an issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").first();
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

    const reviewNote = reviewBlock.getByTestId("proposal-review-note");
    const reviewNoteEditor = reviewNote.locator(".rudder-mdxeditor-content[contenteditable='true']");
    await expect(reviewNoteEditor).toBeVisible();
    await reviewNoteEditor.fill("@pro");
    await expect(page.getByTestId(`markdown-mention-option-agent:${organization.chatAgent.id}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`markdown-mention-option-agent:${organization.chatAgent.id}`).dispatchEvent("mousedown");
    await expect(reviewNote.locator("[data-mention-kind='agent']")).toContainText("Proposal Agent");

    await reviewNoteEditor.press("End");
    await reviewNoteEditor.type(" $advisor");
    const skillOption = page.getByTestId("markdown-mention-menu").locator('[data-testid^="markdown-mention-option-skill:"]').first();
    await expect(skillOption).toContainText("build-advisor", { timeout: 15_000 });
    await skillOption.dispatchEvent("mousedown");
    await expect(reviewNote.locator("[data-skill-token='true']")).toContainText("build-advisor");

    const rejectionFeedback = "Need a concrete execution scope before opening this.";
    await reviewNoteEditor.fill(rejectionFeedback);
    await reviewBlock.getByRole("button", { name: "Reject" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "rejected", { timeout: 15_000 });
    await expect(reviewBlock.getByTestId("proposal-review-status")).toContainText("rejected");
    await expect(reviewBlock).toContainText("Rejected. This proposal will not move forward.");
    await expect(reviewBlock).toContainText(rejectionFeedback);
    await expect(page.getByText('I rejected the proposal "Review block rejection test".')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(rejectionFeedback).last()).toBeVisible();
    await expect(page.getByTestId("proposal-review-block")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByTestId("proposal-review-block").last()).toHaveAttribute("data-status", "pending");
    await expect(page.getByTestId("proposal-review-gate")).toHaveCount(0);
    await expect(page.locator(".rudder-mdxeditor-content").last()).toBeVisible();
  });

  test("rejects proposals without feedback without continuing the conversation", async ({ page }) => {
    const command = await writeProposalStub("proposal-review-reject-without-feedback", {
      kind: "issue_proposal",
      body: "Create a scoped issue for this no-feedback rejection test.",
      structuredPayload: {
        issueProposal: {
          title: "Review block quiet rejection test",
          description: "Verify empty rejection feedback closes the proposal without a follow-up chat turn.",
          priority: "low",
          assigneeUnassignedReason: "This proposal is intentionally unassigned until the rejection flow completes.",
        },
      },
    });
    const organization = await createProposalOrg(page, `RejectQuiet-${Date.now()}`, command);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft an issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page.getByTestId("proposal-review-block").last();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");
    await reviewBlock.getByRole("button", { name: "Reject" }).click();

    await expect(reviewBlock).toHaveAttribute("data-status", "rejected", { timeout: 15_000 });
    await expect(page.getByTestId("proposal-review-block")).toHaveCount(1);
    await expect(page.getByText("I rejected the proposal")).toHaveCount(0);
    await expect(page.locator(".chat-composer").last()).toBeVisible();
  });

  test("requests proposal changes with feedback and continues the conversation", async ({ page }) => {
    const command = await writeProposalStub("proposal-review-request-changes", {
      kind: "issue_proposal",
      body: "Create a revised issue proposal for this request-changes test.",
      structuredPayload: {
        issueProposal: {
          title: "Review block revision test",
          description: "Verify request changes keeps feedback in the chat loop.",
          priority: "medium",
          assigneeUnassignedReason: "The operator will choose an owner after the revised proposal.",
        },
      },
    });
    const organization = await createProposalOrg(page, `RequestChanges-${Date.now()}`, command);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("please draft an issue");
    await page.getByRole("button", { name: "Send" }).click();

    const reviewBlock = page
      .getByTestId("chat-messages-content")
      .getByTestId("proposal-review-block")
      .first();
    await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
    await reviewBlock.getByRole("button", { name: "Show full proposal" }).click();
    const proposalPanel = page.getByTestId("chat-side-panel-issue-proposal-view");
    const panelReviewBlock = proposalPanel.getByTestId("proposal-review-block");
    await expect(panelReviewBlock).toBeVisible();
    const revisionFeedback = "Narrow the acceptance criteria before I approve this.";
    await panelReviewBlock
      .getByTestId("proposal-review-note")
      .locator(".rudder-mdxeditor-content[contenteditable='true']")
      .fill(revisionFeedback);
    await panelReviewBlock.getByRole("button", { name: "Request changes" }).click();

    await expect(panelReviewBlock).toHaveAttribute("data-status", "revision_requested", { timeout: 15_000 });
    await expect(page.getByText('Please revise the proposal "Review block revision test"')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(revisionFeedback).last()).toBeVisible();
    await expect(page.getByTestId("proposal-review-block")).toHaveCount(2, { timeout: 15_000 });
    await expect(
      page.getByTestId("chat-messages-content").getByTestId("proposal-review-block"),
    ).toHaveAttribute("data-status", "pending");
  });

  test("shows approved proposals as completed review blocks", async ({ page }, testInfo) => {
    await page.addInitScript(() => window.localStorage.setItem("rudder.theme", "dark"));
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
    await expect(reviewBlock).toBeVisible({ timeout: 30_000 });
    await expect(reviewBlock).toHaveAttribute("data-status", "pending");
    await expect(page.getByTestId("chat-work-manifest")).toHaveCount(0);
    await expect(reviewBlock.locator("h2")).toHaveText("Execution plan");
    await expect(reviewBlock.locator("ul li")).toHaveCount(2);
    await expect(reviewBlock.locator("code")).toContainText("pnpm test:e2e");
    const approvalFeedback = "Keep feature flag on until smoke validation passes.";
    const reviewNote = reviewBlock.getByTestId("proposal-review-note");
    await reviewNote.locator(".rudder-mdxeditor-content[contenteditable='true']").fill(approvalFeedback);

    await reviewBlock.getByTestId("proposal-review-approve").click();

    await expect(reviewBlock).toHaveAttribute("data-status", "approved", { timeout: 15_000 });
    await expect(reviewBlock.getByTestId("proposal-review-status")).toContainText("approved");
    await expect(reviewBlock).toContainText("Approved. This proposal has been accepted.");
    const outcome = reviewBlock.getByTestId("proposal-review-outcome");
    await expect(outcome).toBeVisible({ timeout: 15_000 });
    await expect(outcome.getByTestId("proposal-review-receipt")).toContainText(/Approved.*Issue .* created/);
    await expect(outcome).toContainText("Execution feedback");
    await expect(outcome).toContainText(approvalFeedback);
    await expect(page.getByText("Approved with execution feedback:")).toHaveCount(0);
    await expect(page.getByText(/^Created issue .* from this chat conversation\.$/)).toHaveCount(0);
    const createdIssueLink = outcome.locator(".chat-system-issue-link").last();
    await expect(createdIssueLink).toBeVisible({ timeout: 15_000 });
    await expect(createdIssueLink).toHaveAttribute("href", /\/issues\//);
    const createdIssueRef = (await createdIssueLink.textContent())?.trim();
    expect(createdIssueRef).toBeTruthy();
    const manifest = page.getByRole("complementary", { name: "Conversation files and links" });
    await expect(manifest).toBeVisible({ timeout: 15_000 });
    const createdIssueManifestRow = manifest.getByRole("button", {
      name: `${createdIssueRef} · Review block approval test`,
      exact: true,
    });
    await expect(createdIssueManifestRow).toBeVisible();
    const createdIssueStatusIcon = createdIssueManifestRow
      .locator("[data-file-icon='issue'][data-issue-status='todo'] [data-slot='issue-status-icon']");
    await expect(createdIssueStatusIcon).toBeVisible();
    await expect(createdIssueStatusIcon).toHaveAttribute("data-status", "todo");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({
      path: testInfo.outputPath("chat-created-issue-manifest-dark.png"),
      fullPage: true,
    });
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
    expect(composerGap!.contentPaddingBottom).toBe("16px");
    const restoredComposer = page.locator(".chat-composer .rudder-mdxeditor-content[contenteditable='true']").last();
    await restoredComposer.fill("Preserve this draft while inspecting the created issue.");
    const chatUrl = page.url();
    await createdIssueManifestRow.click();
    const issueSidePanel = page.getByTestId("chat-side-panel");
    await expect(issueSidePanel).toBeVisible({ timeout: 15_000 });
    await expect(issueSidePanel.getByTestId("chat-side-panel-issue-view")).toBeVisible();
    await expect(issueSidePanel).toContainText(createdIssueRef!);
    await expect(issueSidePanel).toContainText("Review block approval test");
    await expect(page).toHaveURL(chatUrl);
    await page.screenshot({
      path: testInfo.outputPath("chat-created-issue-side-panel-dark.png"),
      fullPage: true,
    });
    await expect(page.getByTestId("chat-work-manifest")).toHaveCount(0);
    await issueSidePanel.getByTestId("chat-side-panel-tab").hover();
    await issueSidePanel.getByTestId("chat-side-panel-tab-close").click();
    await expect(issueSidePanel).toHaveCount(0);
    await expect(manifest).toBeVisible();
    await expect(restoredComposer).toHaveText("Preserve this draft while inspecting the created issue.");
    await createdIssueLink.click();
    await expect(page.getByRole("heading", { name: "Review block approval test" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Approval feedback")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(approvalFeedback)).toBeVisible();
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

  test("lets operators edit proposal owner and reviewer before approval", async ({ page }, testInfo) => {
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
        title: "Operator Assistant",
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
        title: "Independent Reviewer",
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
        initialMessage: {
          body: "Prepare to draft an editable routing issue.",
        },
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
    expect(
      await page.locator('[data-slot="agent-menu-supporting-label"]:visible').allTextContents(),
    ).toContain("Operator Assistant");
    await selectInlineEntityOption(page, "Editable Owner");
    await reviewBlock.getByRole("button", { name: "Edit reviewer" }).click();
    expect(
      await page.locator('[data-slot="agent-menu-supporting-label"]:visible').allTextContents(),
    ).toContain("Independent Reviewer");
    await selectInlineEntityOption(page, "Editable Reviewer");
    await expect(reviewBlock).toContainText("Editable Owner");
    await expect(reviewBlock).toContainText("Editable Reviewer");
    await expect(reviewBlock.getByText("Operator Assistant", { exact: true })).toHaveCount(0);
    await expect(reviewBlock.getByText("Independent Reviewer", { exact: true })).toHaveCount(0);

    const principalLabels = reviewBlock.locator(
      '[data-slot="assignee-label"][data-kind="agent"][data-agent-avatar-style="bare"]',
    );
    await expect(principalLabels).toHaveCount(2);
    await expect(reviewBlock.locator('[data-slot="assignee-agent-avatar-frame"]')).toHaveCount(0);
    await expect(reviewBlock.locator('[data-slot="agent-title-badge"]')).toHaveCount(0);
    const principalAvatars = await principalLabels.evaluateAll((labels) =>
      labels.map((label) => {
        const avatar = label.querySelector<HTMLElement>("svg, img");
        return {
          width: avatar?.getBoundingClientRect().width ?? 0,
          height: avatar?.getBoundingClientRect().height ?? 0,
        };
      }),
    );
    expect(principalAvatars).toEqual([
      { width: 24, height: 24 },
      { width: 24, height: 24 },
    ]);
    await page.screenshot({
      path: testInfo.outputPath("chat-proposal-selected-agents.png"),
      fullPage: false,
    });

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

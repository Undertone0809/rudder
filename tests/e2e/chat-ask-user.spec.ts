import { expect, test, type Locator, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_BIN_DIR } from "./support/e2e-env";

async function writeAskUserStub(
  name: string,
  requestUserInput = {
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "Which scope should the agent implement?",
        options: [
          {
            id: "narrow",
            label: "Narrow path",
            description: "Smallest shippable path",
            recommended: true,
          },
          {
            id: "broad",
            label: "Broad path",
          },
        ],
        allowFreeform: true,
      },
    ],
  },
  options: {
    failFirstAnsweredAttempt?: boolean;
    answeredDelayMs?: number;
  } = {},
) {
  await fs.mkdir(E2E_BIN_DIR, { recursive: true });
  const stubPath = path.join(E2E_BIN_DIR, `${name}.js`);
  const answeredAttemptPath = `${stubPath}.answered-attempt`;
  const stubSource = `#!/usr/bin/env node
import fs from "node:fs";
const requestUserInput = ${JSON.stringify(requestUserInput)};
const answeredAttemptPath = ${JSON.stringify(answeredAttemptPath)};
const failFirstAnsweredAttempt = ${options.failFirstAnsweredAttempt === true};
const answeredDelayMs = ${Math.max(0, options.answeredDelayMs ?? 0)};
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const answered = prompt.includes("Answering the requested input:");
  const answeredWithAttachments = answered
    && prompt.includes("Current user message attachments:")
    && prompt.includes("ask-user-screenshot.png")
    && prompt.includes("receipt.txt");
  if (answered && failFirstAnsweredAttempt && !fs.existsSync(answeredAttemptPath)) {
    fs.writeFileSync(answeredAttemptPath, "failed");
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-ask-user-failed", model: "gpt-5.4" }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Partial model output before failure.",
      },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "turn.failed",
      error: { message: "model generation failed after the operator answered" },
    }) + "\\n");
    process.exit(1);
  }
  const result = answered
    ? {
        kind: "message",
        body: answeredWithAttachments ? "Continuing with pasted attachments." : "Continuing with the narrow path.",
        structuredPayload: null,
      }
    : {
        kind: "ask_user",
        body: "I need one decision before continuing.",
        structuredPayload: {
          requestUserInput,
        },
      };
  const emitResult = () => {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-ask-user", model: "gpt-5.4" }) + "\\n");
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
  };
  if (answered && answeredDelayMs > 0) {
    setTimeout(emitResult, answeredDelayMs);
  } else {
    emitResult();
  }
});
`;
  await fs.writeFile(stubPath, stubSource, "utf8");
  await fs.chmod(stubPath, 0o755);
  return stubPath;
}

async function createAskUserOrg(page: Page, name: string, command: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Ask User Agent",
    command,
  });
  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  return { ...organization, chatAgent };
}

async function pasteAskUserFiles(panel: Locator) {
  const textarea = panel.getByPlaceholder("Type your answer...");
  await expect(textarea).toBeVisible();
  await textarea.evaluate(async (element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create canvas context for ask_user paste test");
    }
    context.fillStyle = "#f8fafc";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#0f766e";
    context.fillRect(40, 40, canvas.width - 80, canvas.height - 80);
    context.fillStyle = "#ffffff";
    context.font = "bold 42px sans-serif";
    context.fillText("ASK USER", 188, 194);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) {
      throw new Error("Failed to create PNG blob for ask_user paste test");
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([blob], "ask-user-screenshot.png", { type: "image/png" }));
    dataTransfer.items.add(new File(["paid"], "receipt.txt", { type: "text/plain" }));

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: dataTransfer,
    });
    element.dispatchEvent(pasteEvent);
  });
}

test("ask_user focuses the answer panel until the user responds", async ({ page }) => {
  const command = await writeAskUserStub(`ask-user-${Date.now()}`);
  const organization = await createAskUserOrg(page, `AskUser-${Date.now()}`, command);

  await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Help me choose scope");
  await page.getByRole("button", { name: "Send" }).click();

  const panel = page.getByTestId("chat-ask-user-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).not.toContainText("Choose an answer to continue");
  await expect(panel).not.toContainText("The assistant is waiting on this decision.");
  await expect(page.locator(".chat-composer")).toHaveCount(0);
  const content = panel.getByTestId("chat-ask-user-content");
  await expect(content).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(content).toHaveCSS("border-top-width", "0px");
  await expect(content).toHaveCSS("padding-top", "0px");

  await panel.getByRole("button", { name: /Narrow path/ }).click();
  await panel.getByRole("button", { name: "Submit answer" }).click();

  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0, { timeout: 15_000 });
  const answer = page.getByTestId("chat-ask-user-answer").last();
  await expect(answer).toHaveClass(/motion-chat-ask-user-answer-pop/);
  await expect(answer).toHaveAttribute("data-motion", "submitted");
  await expect(answer).toHaveCSS("animation-name", "rudder-chat-ask-user-answer-pop");
  await expect(answer).toContainText("Answered");
  await expect(answer).toContainText("Scope");
  await expect(answer).toContainText("Narrow path");
  await expect(answer).not.toHaveAttribute("data-motion", "submitted", { timeout: 3_000 });
  await expect(answer).not.toHaveClass(/motion-chat-ask-user-answer-pop/);
  await expect(answer).toHaveCSS("animation-name", "none");

  await page.reload();
  const historicalAnswer = page.getByTestId("chat-ask-user-answer").last();
  await expect(historicalAnswer).toContainText("Answered", { timeout: 15_000 });
  await expect(historicalAnswer).toContainText("Narrow path");
  await expect(historicalAnswer).not.toHaveAttribute("data-motion", "submitted");
  await expect(historicalAnswer).not.toHaveClass(/motion-chat-ask-user-answer-pop/);
  await expect(page.getByText("Answering the requested input:")).toHaveCount(0);
  await expect(page.getByTestId("chat-ask-user-history").last()).toContainText("Answered");
  await expect(page.locator(".chat-composer").last()).toBeVisible();
  await expect(page.getByText("Continuing with the narrow path.")).toBeVisible();
});

test("retrying a failed answer does not reopen the previous ask_user panel", async ({ page }) => {
  const command = await writeAskUserStub(
    `ask-user-retry-${Date.now()}`,
    undefined,
    { failFirstAnsweredAttempt: true, answeredDelayMs: 1_500 },
  );
  const organization = await createAskUserOrg(page, `AskUserRetry-${Date.now()}`, command);

  await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${organization.chatAgent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Help me choose scope, then continue");
  await page.getByRole("button", { name: "Send" }).click();

  const panel = page.getByTestId("chat-ask-user-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByRole("button", { name: /Narrow path/ }).click();
  await panel.getByRole("button", { name: "Submit answer" }).click();

  const failedMessage = page.getByTestId("chat-assistant-message")
    .filter({ hasText: "Code chat_adapter_failed" });
  await expect(failedMessage).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0);
  await expect(page.getByTestId("chat-ask-user-history").last()).toContainText("Answered");

  await failedMessage.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Thinking", { exact: false }).last()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0);
  await expect(page.getByTestId("chat-ask-user-history").last()).toContainText("Answered");
  await expect(page.getByTestId("chat-ask-user-answer").last()).toContainText("Narrow path");
  await expect(page.getByText("Answering the requested input:")).toHaveCount(0);

  await expect(page.getByText("Continuing with the narrow path.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0);
});

test("ask_user steps multi-question requests through one question at a time", async ({ page }) => {
  const command = await writeAskUserStub(`ask-user-multi-${Date.now()}`, {
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "Which scope should the agent implement?",
        options: [
          { id: "narrow", label: "Narrow path", recommended: true },
          { id: "broad", label: "Broad path" },
        ],
        allowFreeform: true,
      },
      {
        id: "risk",
        header: "Risk",
        question: "Which risk matters most?",
        options: [
          { id: "tests", label: "Missing tests" },
          { id: "copy", label: "Copy clarity" },
        ],
        allowFreeform: true,
      },
      {
        id: "handoff",
        header: "Handoff",
        question: "What should the handoff include?",
        options: [
          { id: "summary", label: "Short summary" },
          { id: "full", label: "Full report" },
        ],
        allowFreeform: true,
      },
    ],
  });
  const organization = await createAskUserOrg(page, `AskUserMulti-${Date.now()}`, command);

  await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Help me choose scope");
  await page.getByRole("button", { name: "Send" }).click();

  const panel = page.getByTestId("chat-ask-user-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText("Question 1 of 3");
  await expect(panel).toContainText("Narrow path");
  await expect(panel).not.toContainText("Missing tests");
  await expect(panel).not.toContainText("Short summary");

  await panel.getByRole("button", { name: /Narrow path/ }).click();
  await expect(panel).toContainText("Question 2 of 3");
  await expect(panel).toContainText("Missing tests");
  await expect(panel).not.toContainText("Short summary");

  await panel.getByRole("button", { name: "Other" }).click();
  await panel.getByPlaceholder("Type your answer...").fill("Keep the browser regression small");
  await panel.getByRole("button", { name: "Next" }).click();
  await expect(panel).toContainText("Question 3 of 3");

  await panel.getByRole("button", { name: /Full report/ }).click();
  await expect(panel).toContainText("Review answers");
  await expect(panel).toContainText("Narrow path");
  await expect(panel).toContainText("Keep the browser regression small");
  await expect(panel).toContainText("Full report");

  await panel.getByRole("button", { name: "Submit answer" }).click();
  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0, { timeout: 15_000 });
  const answer = page.getByTestId("chat-ask-user-answer").last();
  await expect(answer).toContainText("Scope");
  await expect(answer).toContainText("Narrow path");
  await expect(answer).toContainText("Risk");
  await expect(answer).toContainText("Keep the browser regression small");
  await expect(answer).toContainText("Handoff");
  await expect(answer).toContainText("Full report");
});

test("ask_user keeps long review feedback inside a bounded scrolling region", async ({ page }) => {
  const command = await writeAskUserStub(`ask-user-long-review-${Date.now()}`, {
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "Which scope should the agent implement?",
        options: [
          { id: "narrow", label: "Narrow path", recommended: true },
          { id: "broad", label: "Broad path" },
        ],
        allowFreeform: true,
      },
      {
        id: "feedback",
        header: "Feedback",
        question: "What detailed feedback should the agent follow?",
        options: [
          { id: "summary", label: "Short summary" },
          { id: "details", label: "Detailed notes" },
        ],
        allowFreeform: true,
      },
    ],
  });
  const organization = await createAskUserOrg(page, `AskUserLongReview-${Date.now()}`, command);

  await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Help me review detailed feedback");
  await page.getByRole("button", { name: "Send" }).click();

  const panel = page.getByTestId("chat-ask-user-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByRole("button", { name: /Narrow path/ }).click();
  await panel.getByRole("button", { name: "Other" }).click();
  await panel.getByPlaceholder("Type your answer...").fill(
    Array.from({ length: 70 }, (_, index) => `Feedback line ${index + 1}`).join("\n"),
  );
  await panel.getByRole("button", { name: "Review answers" }).click();

  const reviewScroll = panel.getByTestId("chat-ask-user-review-scroll");
  await expect(reviewScroll).toBeVisible();
  const metrics = await reviewScroll.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflowY: getComputedStyle(node).overflowY,
    viewportHeight: window.innerHeight,
  }));
  expect(metrics.overflowY).toBe("auto");
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.clientHeight).toBeLessThanOrEqual(Math.min(metrics.viewportHeight * 0.48, 448) + 1);

  await reviewScroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect.poll(() => reviewScroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(panel.getByRole("button", { name: "Submit answer" })).toBeVisible();
});

test("ask_user restores unfinished answers after leaving and returning to the chat", async ({ page }) => {
  const command = await writeAskUserStub(`ask-user-draft-${Date.now()}`, {
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "Which scope should the agent implement?",
        options: [
          { id: "narrow", label: "Narrow path", recommended: true },
          { id: "broad", label: "Broad path" },
        ],
        allowFreeform: true,
      },
      {
        id: "risk",
        header: "Risk",
        question: "Which risk matters most?",
        options: [
          { id: "tests", label: "Missing tests" },
          { id: "copy", label: "Copy clarity" },
        ],
        allowFreeform: true,
      },
    ],
  });
  const organization = await createAskUserOrg(page, `AskUserDraft-${Date.now()}`, command);

  await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Help me choose scope");
  await page.getByRole("button", { name: "Send" }).click();

  const panel = page.getByTestId("chat-ask-user-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const chatUrl = page.url();
  await panel.getByRole("button", { name: /Broad path/ }).click();
  await expect(panel).toContainText("Question 2 of 2");
  await panel.getByRole("button", { name: "Other" }).click();
  await panel.getByPlaceholder("Type your answer...").fill("Keep the browser regression small");
  await panel.getByRole("button", { name: "Review answers" }).click();
  await expect(panel).toContainText("Review answers");
  await expect(panel).toContainText("Broad path");
  await expect(panel).toContainText("Keep the browser regression small");

  await page.goto("/");
  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0);

  await page.goto(chatUrl);
  const restoredPanel = page.getByTestId("chat-ask-user-panel");
  await expect(restoredPanel).toBeVisible({ timeout: 15_000 });
  await expect(restoredPanel).toContainText("Review answers");
  await expect(restoredPanel).toContainText("Broad path");
  await expect(restoredPanel).toContainText("Keep the browser regression small");

  await restoredPanel.getByRole("button", { name: "Submit answer" }).click();
  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0, { timeout: 15_000 });
  const answer = page.getByTestId("chat-ask-user-answer").last();
  await expect(answer).toContainText("Scope");
  await expect(answer).toContainText("Broad path");
  await expect(answer).toContainText("Risk");
  await expect(answer).toContainText("Keep the browser regression small");
});

test("ask_user supports multi-select questions", async ({ page }) => {
  const command = await writeAskUserStub(`ask-user-multi-select-${Date.now()}`, {
    questions: [
      {
        id: "evidence",
        header: "Evidence",
        question: "Which evidence should the agent collect?",
        selectionMode: "multiple",
        options: [
          { id: "tests", label: "Test output" },
          { id: "screenshots", label: "Screenshots" },
          { id: "diff", label: "Diff summary" },
        ],
        allowFreeform: false,
      },
    ],
  });
  const organization = await createAskUserOrg(page, `AskUserMultiSelect-${Date.now()}`, command);

  await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Help me choose evidence");
  await page.getByRole("button", { name: "Send" }).click();

  const panel = page.getByTestId("chat-ask-user-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByRole("button", { name: /Test output/ }).click();
  await expect(panel.getByRole("button", { name: /Screenshots/ })).toBeVisible();
  await panel.getByRole("button", { name: /Screenshots/ }).click();
  await panel.getByRole("button", { name: "Submit answer" }).click();

  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0, { timeout: 15_000 });
  const answer = page.getByTestId("chat-ask-user-answer").last();
  await expect(answer).toContainText("Evidence");
  await expect(answer).toContainText("Test output, Screenshots");
});

test("ask_user always offers a freeform steer when allowFreeform is false", async ({ page }) => {
  const command = await writeAskUserStub(`ask-user-freeform-legacy-${Date.now()}`, {
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "Which scope should the agent implement?",
        options: [
          { id: "narrow", label: "Narrow path" },
          { id: "broad", label: "Broad path" },
        ],
        allowFreeform: false,
      },
    ],
  });
  const organization = await createAskUserOrg(page, `AskUserFreeformLegacy-${Date.now()}`, command);

  await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Help me choose a scope");
  await page.getByRole("button", { name: "Send" }).click();

  const panel = page.getByTestId("chat-ask-user-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("button", { name: "Narrow path" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Other" })).toBeVisible();

  await panel.getByRole("button", { name: "Other" }).click();
  const submit = panel.getByRole("button", { name: "Submit answer" });
  await expect(submit).toBeDisabled();
  await panel.getByPlaceholder("Type your answer...").fill("Use the custom compatibility path");
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0, { timeout: 15_000 });
  const answer = page.getByTestId("chat-ask-user-answer").last();
  await expect(answer).toContainText("Scope");
  await expect(answer).toContainText("Use the custom compatibility path");
  await expect(page.getByText("Continuing with the narrow path.")).toBeVisible({ timeout: 30_000 });
});

test("ask_user Other answer accepts pasted image and file attachments", async ({ page }) => {
  const command = await writeAskUserStub(`ask-user-paste-${Date.now()}`);
  const organization = await createAskUserOrg(page, `AskUserPaste-${Date.now()}`, command);

  await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("I will need to paste payment evidence");
  await page.getByRole("button", { name: "Send" }).click();

  const panel = page.getByTestId("chat-ask-user-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Other" }).click();
  await pasteAskUserFiles(panel);

  const pendingAttachments = panel.getByTestId("chat-ask-user-pending-attachment");
  await expect(pendingAttachments).toHaveCount(2);
  const pendingImage = panel.getByTestId("chat-pending-image-attachment");
  await expect(pendingImage).toBeVisible();
  await expect(pendingImage.getByAltText("ask-user-screenshot.png")).toBeVisible();
  await expect(pendingAttachments.filter({ hasText: "receipt.txt" })).toBeVisible();

  await panel.getByRole("button", { name: "Submit answer" }).click();
  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0, { timeout: 15_000 });

  const answer = page.getByTestId("chat-ask-user-answer").last();
  await expect(answer).toContainText("Scope");
  await expect(answer).toContainText("See attached files.");

  await expect(page.getByRole("button", { name: "Open image preview: ask-user-screenshot.png" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "receipt.txt" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-pending-attachment")).toHaveCount(0);
  await expect(page.getByText("Continuing with pasted attachments.")).toBeVisible({ timeout: 15_000 });
});

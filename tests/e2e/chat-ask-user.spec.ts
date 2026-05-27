import { expect, test, type Page } from "@playwright/test";
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
) {
  await fs.mkdir(E2E_BIN_DIR, { recursive: true });
  const stubPath = path.join(E2E_BIN_DIR, `${name}.js`);
  const stubSource = `#!/usr/bin/env node
const requestUserInput = ${JSON.stringify(requestUserInput)};
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const answered = prompt.includes("Answering the requested input:");
  const result = answered
    ? {
        kind: "message",
        body: "Continuing with the narrow path.",
        structuredPayload: null,
      }
    : {
        kind: "ask_user",
        body: "I need one decision before continuing.",
        structuredPayload: {
          requestUserInput,
        },
      };
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

  await panel.getByRole("button", { name: /Narrow path/ }).click();
  await panel.getByRole("button", { name: "Submit answer" }).click();

  await expect(page.getByTestId("chat-ask-user-panel")).toHaveCount(0, { timeout: 15_000 });
  const answer = page.getByTestId("chat-ask-user-answer").last();
  await expect(answer).toContainText("Answered");
  await expect(answer).toContainText("Scope");
  await expect(answer).toContainText("Narrow path");
  await expect(page.getByText("Answering the requested input:")).toHaveCount(0);
  await expect(page.getByTestId("chat-ask-user-history").last()).toContainText("Answered");
  await expect(page.locator(".chat-composer").last()).toBeVisible();
  await expect(page.getByText("Continuing with the narrow path.")).toBeVisible();
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

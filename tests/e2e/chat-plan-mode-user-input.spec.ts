import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { E2E_BIN_DIR } from "./support/e2e-env";

async function writePlanModeQuestionStub(name: string) {
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
  const answered = prompt.includes("Selected answers for request_user_input");
  const result = answered
    ? {
        kind: "message",
        body: "Thanks, I can plan with those constraints.",
        structuredPayload: null,
      }
    : {
        kind: "user_input_request",
        body: "Choose the constraints before I write the implementation plan.",
        structuredPayload: {
          requestUserInput: {
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "How narrow should this plan be?",
                options: [
                  { id: "minimal_patch", label: "Minimal patch", description: "Touch only the plan-mode request path." },
                  { id: "full_redesign", label: "Full redesign", description: "Rework the whole chat planning flow." },
                ],
              },
              {
                id: "coverage",
                header: "Coverage",
                question: "Which verification depth should I target?",
                options: [
                  { id: "unit_only", label: "Unit only", description: "Keep validation fast and local." },
                  { id: "add_e2e", label: "Add E2E", description: "Cover the visible operator workflow." },
                ],
              },
            ],
          },
        },
      };
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-question", model: "gpt-5.4" }) + "\\n");
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

async function createPlanModeChat(page: Page, command: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Plan-Input-${Date.now()}`,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
        command,
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Plan mode user input",
      planMode: true,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  return { organization, chat };
}

test.describe("Chat plan mode user input", () => {
  test("renders request_user_input choices and sends selected answers", async ({ page }) => {
    const command = await writePlanModeQuestionStub("codex-plan-input");
    const { chat } = await createPlanModeChat(page, command);

    await page.goto(`/chat/${chat.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No messages yet. Start by describing the work and Rudder will clarify it first.")).toBeVisible({
      timeout: 15_000,
    });
    await composer.fill("Plan this change");
    await page.getByRole("button", { name: "Send" }).click();

    const requestCard = page.getByTestId("chat-user-input-request").last();
    await expect(requestCard).toBeVisible({ timeout: 15_000 });
    await expect(requestCard).toContainText("request_user_input");
    await expect(requestCard).toContainText("How narrow should this plan be?");
    await expect(requestCard).toContainText("Which verification depth should I target?");

    await requestCard.getByRole("button", { name: /Minimal patch/ }).click();
    await requestCard.getByRole("button", { name: /Add E2E/ }).click();
    const submitAnswer = requestCard.getByTestId("chat-user-input-submit");
    await expect(submitAnswer).toBeEnabled({ timeout: 15_000 });
    await submitAnswer.click();

    await expect(page.getByTestId("chat-user-message-bubble").last()).toContainText("Scope: Minimal patch", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("chat-user-message-bubble").last()).toContainText("Coverage: Add E2E");
    await expect(page.getByText("Thanks, I can plan with those constraints.").first()).toBeVisible({ timeout: 15_000 });
  });
});

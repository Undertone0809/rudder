import { expect, test } from "@playwright/test";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_ROOT } from "./support/e2e-env";

// This is a UI/Reader shape regression, not installed-Hermes execution proof.
// The real-runtime acceptance separately uses the local Hermes provider.
test("Chat refresh presents Hermes native tool-only rows without leaking the assembled user prompt", async ({ page }, testInfo) => {
  const response = await page.request.post("/api/orgs", { data: { name: `Hermes Presentation ${Date.now()}` } });
  expect(response.ok()).toBe(true);
  const org = await response.json();
  const agent = await createE2EChatAgent(page.request, org.id, {
    command: path.join(E2E_ROOT, "fixtures/codex-native-session.mjs"),
  });
  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("rudder.selectedOrganizationId", id), org.id);
  await page.goto(`/${org.urlKey}/messenger/chat?agentId=${agent.id}`);
  await page.locator(".rudder-mdxeditor-content").first().fill("Presentation regression");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Native reply 1", { timeout: 30_000 });

  await page.route("**/api/run-intelligence/runs/*/transcript?*", async (route) => {
    const original = await route.fetch();
    const body = await original.json();
    const ts = "2026-10-02T03:11:56.000Z";
    body.source = "native_plus_objects";
    body.entries = [
      { id: "native-user", entry: { kind: "user", role: "user", rowId: 1, sessionId: "hermes", ts,
        text: "Conversation input: STRUCTURED-PROMPT-MUST-NOT-RENDER" } },
      { id: "native-call", entry: { kind: "assistant", role: "assistant", rowId: 2, sessionId: "hermes", ts,
        reasoningContent: "Checking the requested tool", toolCalls: [
          { id: "call-1", function: { name: "tool_describe", arguments: "{}" } },
        ] } },
      { id: "native-result", entry: { kind: "hermes:db:tool", ts, toolCallId: "call-1",
        toolName: "tool_describe", text: "Tool description returned" } },
      { id: "native-final", entry: { kind: "assistant", role: "assistant", rowId: 4, sessionId: "hermes", ts,
        text: "Native reply 1" } },
      { id: "supplement-todo", entry: { kind: "todo_list", ts, todoListId: "supplement",
        items: [{ text: "Preserved supplemental task", status: "completed" }] } },
    ];
    await route.fulfill({ response: original, json: body });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Native reply 1");
  await expect(page.getByTestId("chat-transcript-item")).toBeVisible();
  await page.getByTestId("chat-transcript-item").getByRole("button").first().click();
  await expect(page.getByText("Checking the requested tool", { exact: true })).toBeVisible();
  await expect(page.getByText("Preserved supplemental task", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Expand tool details: Tool Describe", exact: true }).click();
  await expect(page.getByText("Tool description returned", { exact: false })).toBeVisible();
  await expect(page.getByText("STRUCTURED-PROMPT-MUST-NOT-RENDER", { exact: false })).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("hermes-native-process.png"), fullPage: true });
});

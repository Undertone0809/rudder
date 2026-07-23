import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Capture = {
  argv: string[];
  prompt: string;
};

async function readCaptures(capturePath: string): Promise<Capture[]> {
  try {
    const body = await fs.readFile(capturePath, "utf8");
    return body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Capture);
  } catch {
    return [];
  }
}

function capturedModel(capture: Capture) {
  const modelIndex = capture.argv.indexOf("--model");
  return modelIndex >= 0 ? capture.argv[modelIndex + 1] ?? null : null;
}

test("persists one conversation override, freezes running and queued models, and resets new Chat", async ({ page }, testInfo) => {
  test.slow();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-chat-model-selector-"));
  const commandPath = path.join(tempDir, "codex-chat-model-stub");
  const capturePath = path.join(tempDir, "captures.ndjson");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", async () => {
  fs.appendFileSync(process.env.RUDDER_TEST_CAPTURE_PATH, JSON.stringify({
    argv: process.argv.slice(2),
    prompt,
  }) + "\\n", "utf8");
  const delayMs = prompt.includes("Start with the Terra override") ? 45000 : 1000;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const body = "Model capture reply.";
  const result = sentinel + JSON.stringify({ kind: "message", body, structuredPayload: null });
  console.log(JSON.stringify({ type: "thread.started", thread_id: "chat-model-selector-e2e" }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: result },
  }));
  console.log(JSON.stringify({
    type: "turn.completed",
    result,
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  }));
});
`;
  await fs.writeFile(commandPath, script, { mode: 0o755 });

  try {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Chat-Model-Selector-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };
    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Conversation Model Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          command: commandPath,
          model: "gpt-5.5",
          modelReasoningEffort: "high",
          search: false,
          dangerouslyBypassApprovalsAndSandbox: true,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.theme", "dark");
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);

    const agentSelector = page.getByTestId("chat-agent-selector");
    await expect(agentSelector).toContainText("Conversation Model Agent", { timeout: 15_000 });
    await agentSelector.click();
    const modelSelector = page.getByTestId("chat-model-selector");
    await expect(modelSelector).toHaveValue("");
    await expect(modelSelector.locator("option").first()).toHaveText("Agent default · gpt-5.5");
    await modelSelector.selectOption("gpt-5.6-terra");
    await expect(modelSelector).toHaveValue("gpt-5.6-terra");
    await agentSelector.click();

    const composer = page.getByTestId("chat-composer-editor-scroll")
      .locator(".rudder-mdxeditor-content")
      .first();
    await composer.fill("Start with the Terra override");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/messenger\/chat\/[^/]+$/i, { timeout: 45_000 });
    const firstConversationId = page.url().split("/").pop()!;
    await expect.poll(async () => (await readCaptures(capturePath)).length, {
      timeout: 45_000,
    }).toBe(1);
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible();

    await agentSelector.click();
    await expect(page.getByRole("menuitemradio", { name: /Conversation Model Agent/ })).toBeDisabled();
    const runningModelSelector = page.getByTestId("chat-model-selector");
    const patchResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/chats/${firstConversationId}`),
    );
    await runningModelSelector.selectOption("gpt-5.6-luna");
    expect((await patchResponse).ok()).toBe(true);
    await expect(runningModelSelector).toHaveValue("gpt-5.6-luna");
    await expect(runningModelSelector).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("conversation-model-selector-running-dark.png"),
      fullPage: true,
    });
    await agentSelector.click();

    await composer.fill("Queue this with Luna");
    const queueResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/chats/${firstConversationId}/queue`),
    );
    await composer.press("Enter");
    const queueResponse = await queueResponsePromise;
    expect(queueResponse.ok()).toBe(true);
    const queued = await queueResponse.json() as { payload: { model: string | null } };
    expect(queued.payload.model).toBe("gpt-5.6-luna");

    await agentSelector.click();
    const postAdmissionModelSelector = page.getByTestId("chat-model-selector");
    const postAdmissionPatch = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/chats/${firstConversationId}`),
    );
    await postAdmissionModelSelector.selectOption("gpt-5.6-sol");
    expect((await postAdmissionPatch).ok()).toBe(true);
    await expect(postAdmissionModelSelector).toBeEnabled();
    await agentSelector.click();

    await expect.poll(async () => (await readCaptures(capturePath)).length, {
      timeout: 75_000,
    }).toBe(2);
    const firstTwoCaptures = await readCaptures(capturePath);
    expect(firstTwoCaptures.map(capturedModel)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);

    await page.reload();
    await agentSelector.click();
    await expect(page.getByTestId("chat-model-selector")).toHaveValue("gpt-5.6-sol");
    await agentSelector.click();
    const persistedRes = await page.request.get(`/api/chats/${firstConversationId}`);
    expect(persistedRes.ok()).toBe(true);
    expect((await persistedRes.json()).modelOverride).toBe("gpt-5.6-sol");

    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);
    await expect(agentSelector).toContainText("Conversation Model Agent", { timeout: 15_000 });
    await agentSelector.click();
    await expect(page.getByTestId("chat-model-selector")).toHaveValue("");
    await agentSelector.click();
    await composer.fill("A separate conversation uses the Agent default");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(async () => (await readCaptures(capturePath)).length, {
      timeout: 45_000,
    }).toBe(3);
    const captures = await readCaptures(capturePath);
    expect(captures.map(capturedModel)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

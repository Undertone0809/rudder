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

function capturedEffort(capture: Capture) {
  const effortArg = capture.argv.find((value) => value.startsWith("model_reasoning_effort="));
  if (!effortArg) return null;
  return JSON.parse(effortArg.slice("model_reasoning_effort=".length)) as string;
}

async function chooseRuntimeOption(
  page: import("@playwright/test").Page,
  kind: "model" | "effort",
  value: string | null,
) {
  await page.getByTestId(`chat-${kind}-selector`).click();
  await page.getByTestId(`chat-${kind}-option-${value ?? "default"}`).click();
}

async function openRuntimePanel(page: import("@playwright/test").Page) {
  if (!await page.getByTestId("chat-agent-menu").isVisible().catch(() => false)) {
    await page.getByTestId("chat-agent-selector").click();
  }
  const runtimeSelector = page.getByTestId("chat-agent-runtime-selector");
  await expect(runtimeSelector).toBeVisible();
  if (!await page.getByTestId("chat-agent-runtime-panel").isVisible().catch(() => false)) {
    await runtimeSelector.click();
  }
  await expect(page.getByTestId("chat-agent-runtime-panel")).toBeVisible();
}

async function closeRuntimePanelAndAgentMenu(page: import("@playwright/test").Page) {
  for (const kind of ["model", "effort"] as const) {
    const options = page.getByTestId(`chat-${kind}-options`);
    if (await options.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await expect(options).toBeHidden();
    }
  }
  const runtimePanel = page.getByTestId("chat-agent-runtime-panel");
  if (await runtimePanel.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(runtimePanel).toBeHidden();
  }
  const agentMenu = page.getByTestId("chat-agent-menu");
  if (await agentMenu.isVisible().catch(() => false)) {
    await page.getByTestId("chat-agent-selector").click();
    await expect(agentMenu).toBeHidden();
  }
}

test("closes the Agent selector when the operator clicks elsewhere in the composer", async ({ page }, testInfo) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Agent-Selector-Dismiss-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as {
    id: string;
    issuePrefix: string;
  };
  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Selector Dismiss Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "medium",
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
  const composer = page.getByTestId("chat-composer-editor-scroll")
    .locator(".rudder-mdxeditor-content")
    .first();
  await expect(agentSelector).toContainText("Selector Dismiss Agent", { timeout: 15_000 });
  await agentSelector.click();
  await expect(page.getByTestId("chat-agent-menu")).toBeVisible();

  const composerBox = await composer.boundingBox();
  expect(composerBox).not.toBeNull();
  await page.mouse.click(
    composerBox!.x + composerBox!.width - 12,
    composerBox!.y + 12,
  );

  await expect(page.getByTestId("chat-agent-menu")).toBeHidden();
  await expect(agentSelector).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({
    path: testInfo.outputPath("agent-selector-dismissed-by-composer-click.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("submits per-message runtime overrides without persisting conversation settings", async ({ page }, testInfo) => {
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
  const delayMs = prompt.includes("Start with the Terra override") ? 15000 : 1000;
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
    await agentSelector.focus();
    await agentSelector.press("Enter");
    await expect(page.getByTestId(`chat-agent-option-${agent.id}`).getByRole("menuitemradio")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(agentSelector).toBeFocused();
    await openRuntimePanel(page);
    await expect(page.getByTestId("chat-agent-menu")).toContainText("Conversation Model Agent");
    await expect(page.getByTestId("chat-agent-runtime-selector")).toContainText("gpt-5.5 · High");
    const modelSelector = page.getByTestId("chat-model-selector");
    const effortSelector = page.getByTestId("chat-effort-selector");
    await expect(modelSelector).toHaveAttribute("data-value", "");
    await expect(modelSelector).toContainText("gpt-5.5");
    await expect(effortSelector).toHaveAttribute("data-value", "");
    await expect(effortSelector).toContainText("High");
    await chooseRuntimeOption(page, "model", "gpt-5.6-terra");
    await expect(modelSelector).toHaveAttribute("data-value", "gpt-5.6-terra");
    await chooseRuntimeOption(page, "effort", "xhigh");
    await expect(effortSelector).toHaveAttribute("data-value", "xhigh");
    await closeRuntimePanelAndAgentMenu(page);

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

    const conversationPatchRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "PATCH"
        && request.url().includes(`/api/chats/${firstConversationId}`)
      ) {
        conversationPatchRequests.push(request.postData() ?? "");
      }
    });
    await openRuntimePanel(page);
    await expect(page.getByTestId("chat-agent-lock-state")).toContainText("Bound to chat");
    const runningModelSelector = page.getByTestId("chat-model-selector");
    const runningEffortSelector = page.getByTestId("chat-effort-selector");
    await chooseRuntimeOption(page, "model", "gpt-5.6-luna");
    await expect(runningModelSelector).toHaveAttribute("data-value", "gpt-5.6-luna");
    await chooseRuntimeOption(page, "effort", "medium");
    await expect(runningEffortSelector).toHaveAttribute("data-value", "medium");
    expect(conversationPatchRequests).toEqual([]);
    await expect(page.getByText("Saving for this conversation…")).toHaveCount(0);
    await runningEffortSelector.hover();
    await expect(page.getByTestId("chat-effort-options")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("conversation-model-selector-running-dark.png"),
      fullPage: true,
      animations: "disabled",
    });
    await closeRuntimePanelAndAgentMenu(page);

    await composer.fill("Queue this with Luna");
    const queueResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/chats/${firstConversationId}/queue`),
    );
    await composer.press("Enter");
    const queueResponse = await queueResponsePromise;
    expect(queueResponse.ok()).toBe(true);
    const queued = await queueResponse.json() as {
      runtimeSnapshotVersion: number | null;
      payload: { agentId: string | null; model: string | null; effort: string | null };
    };
    expect(queued.runtimeSnapshotVersion).toBe(1);
    expect(queued.payload.agentId).toBe(agent.id);
    expect(queued.payload.model).toBe("gpt-5.6-luna");
    expect(queued.payload.effort).toBe("medium");

    await openRuntimePanel(page);
    await expect(page.getByTestId("chat-model-selector")).toHaveAttribute("data-value", "");
    await expect(page.getByTestId("chat-effort-selector")).toHaveAttribute("data-value", "");
    await closeRuntimePanelAndAgentMenu(page);

    await expect.poll(async () => (await readCaptures(capturePath)).length, {
      timeout: 75_000,
    }).toBe(2);
    const firstTwoCaptures = await readCaptures(capturePath);
    expect(firstTwoCaptures.map(capturedModel)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(firstTwoCaptures.map(capturedEffort)).toEqual([
      "xhigh",
      "medium",
    ]);

    await page.reload();
    await openRuntimePanel(page);
    await expect(page.getByTestId("chat-model-selector"))
      .toHaveAttribute("data-value", "");
    await expect(page.getByTestId("chat-effort-selector"))
      .toHaveAttribute("data-value", "");
    await closeRuntimePanelAndAgentMenu(page);
    const persistedRes = await page.request.get(`/api/chats/${firstConversationId}`);
    expect(persistedRes.ok()).toBe(true);
    expect(await persistedRes.json()).toMatchObject({
      modelOverride: null,
      effortOverride: null,
    });
    expect(conversationPatchRequests).toEqual([]);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);
    await expect(agentSelector).toContainText("Conversation Model Agent", { timeout: 15_000 });
    await openRuntimePanel(page);
    await expect(page.getByTestId("chat-agent-runtime-selector")).toContainText("gpt-5.5 · High");
    await expect(page.getByTestId("chat-model-selector")).toHaveAttribute("data-value", "");
    await expect(page.getByTestId("chat-effort-selector")).toHaveAttribute("data-value", "");
    await closeRuntimePanelAndAgentMenu(page);
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
    expect(captures.map(capturedEffort)).toEqual([
      "xhigh",
      "medium",
      "high",
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

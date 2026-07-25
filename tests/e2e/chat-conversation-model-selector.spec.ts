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

test("persists conversation runtime overrides, freezes running and queued turns, and resets new Chat", async ({ page }, testInfo) => {
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

    const runtimeSelector = page.getByTestId("chat-runtime-selector");
    await expect(runtimeSelector).toContainText("gpt-5.5 · High", { timeout: 15_000 });
    await runtimeSelector.focus();
    await runtimeSelector.press("Enter");
    await expect(page.getByTestId("chat-model-selector")).toBeFocused();
    await page.getByTestId("chat-model-selector").press("Escape");
    await expect(runtimeSelector).toBeFocused();
    await runtimeSelector.click();
    await expect(page.getByTestId("chat-runtime-menu")).not.toContainText("Conversation Model Agent");
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
    await runtimeSelector.click();

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

    await runtimeSelector.click();
    await expect(page.getByTestId("chat-runtime-menu")).not.toContainText("Agents");
    const runningModelSelector = page.getByTestId("chat-model-selector");
    const runningEffortSelector = page.getByTestId("chat-effort-selector");
    let releaseModelPatch!: () => void;
    const modelPatchGate = new Promise<void>((resolve) => {
      releaseModelPatch = resolve;
    });
    let observeModelPatch!: () => void;
    const modelPatchObserved = new Promise<void>((resolve) => {
      observeModelPatch = resolve;
    });
    await page.route(`**/api/chats/${firstConversationId}`, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      observeModelPatch();
      await modelPatchGate;
      await route.continue();
    });
    const modelPatchResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/chats/${firstConversationId}`),
    );
    await chooseRuntimeOption(page, "model", "gpt-5.6-luna");
    await modelPatchObserved;
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeEnabled();
    releaseModelPatch();
    expect((await modelPatchResponse).ok()).toBe(true);
    await page.unroute(`**/api/chats/${firstConversationId}`);
    await expect(runningModelSelector).toHaveAttribute("data-value", "gpt-5.6-luna");
    await expect(runningEffortSelector).toBeEnabled();
    const effortPatchResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/chats/${firstConversationId}`),
    );
    await chooseRuntimeOption(page, "effort", "medium");
    expect((await effortPatchResponse).ok()).toBe(true);
    await expect(runningEffortSelector).toHaveAttribute("data-value", "medium");
    await expect(runningModelSelector).toBeEnabled();
    await runningEffortSelector.hover();
    await expect(page.getByTestId("chat-effort-options")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("conversation-model-selector-running-dark.png"),
      fullPage: true,
    });
    await runtimeSelector.click();

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
      payload: { model: string | null; effort: string | null };
    };
    expect(queued.runtimeSnapshotVersion).toBe(1);
    expect(queued.payload.model).toBe("gpt-5.6-luna");
    expect(queued.payload.effort).toBe("medium");

    await runtimeSelector.click();
    const postAdmissionModelSelector = page.getByTestId("chat-model-selector");
    const postAdmissionEffortSelector = page.getByTestId("chat-effort-selector");
    const postAdmissionPatch = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/chats/${firstConversationId}`),
    );
    await chooseRuntimeOption(page, "model", "gpt-5.6-sol");
    expect((await postAdmissionPatch).ok()).toBe(true);
    await expect(postAdmissionModelSelector).toBeEnabled();
    await expect(postAdmissionEffortSelector).toBeEnabled();
    const postAdmissionEffortPatch = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/chats/${firstConversationId}`),
    );
    await chooseRuntimeOption(page, "effort", "ultra");
    expect((await postAdmissionEffortPatch).ok()).toBe(true);
    await runtimeSelector.click();

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
    await runtimeSelector.click();
    await expect(page.getByTestId("chat-model-selector"))
      .toHaveAttribute("data-value", "gpt-5.6-sol");
    await expect(page.getByTestId("chat-effort-selector"))
      .toHaveAttribute("data-value", "ultra");
    await runtimeSelector.click();
    const persistedRes = await page.request.get(`/api/chats/${firstConversationId}`);
    expect(persistedRes.ok()).toBe(true);
    expect(await persistedRes.json()).toMatchObject({
      modelOverride: "gpt-5.6-sol",
      effortOverride: "ultra",
    });

    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);
    await expect(runtimeSelector).toContainText("gpt-5.5 · High", { timeout: 15_000 });
    await runtimeSelector.click();
    await expect(page.getByTestId("chat-model-selector")).toHaveAttribute("data-value", "");
    await expect(page.getByTestId("chat-effort-selector")).toHaveAttribute("data-value", "");
    await runtimeSelector.click();
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

import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test.describe("Codex model order", () => {
  test.beforeEach(({ page }) => {
    page.on("console", (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => console.log(`[browser:pageerror] ${error.stack ?? error.message}`));
  });

  test("shows newest Codex models first in the selected Agent menu", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Codex-Model-Order-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await page.route(`**/api/orgs/${organization.id}/adapters/codex_local/models`, async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: [
          { id: "gpt-5.6-sol", label: "GPT-5.6-sol", variants: ["low", "medium", "high", "xhigh", "max", "ultra"] },
          { id: "gpt-5.6-terra", label: "GPT-5.6-terra", variants: ["low", "medium", "high", "xhigh", "max", "ultra"] },
          { id: "gpt-5.6-luna", label: "GPT-5.6-luna", variants: ["low", "medium", "high", "xhigh", "max"] },
          { id: "gpt-5.5", label: "GPT-5.5", variants: ["low", "medium", "high", "xhigh"] },
          { id: "gpt-5.4", label: "GPT-5.4", variants: ["low", "medium", "high", "xhigh"] },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", variants: ["low", "medium", "high", "xhigh"] },
          { id: "gpt-5.2", label: "GPT-5.2", variants: ["low", "medium", "high", "xhigh"] },
        ],
      });
    });

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Newest First Agent",
        role: "general",
        title: "Coding Agent",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          command: "codex",
          model: "gpt-5.5",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });

    await page.getByTestId("workspace-main-header")
      .getByRole("button", { name: "Create Issue" })
      .click();
    const dialog = page.locator('[data-slot="dialog-content"]')
      .filter({ has: page.getByText("New issue") })
      .first();
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "No assignee", exact: true }).click();
    await page.getByRole("button", { name: /Newest First Agent/ }).click();
    const selectedAgentOption = page.locator("[data-inline-entity-option]").filter({ hasText: "Newest First Agent" });
    const runtimeSelector = selectedAgentOption.getByTestId("issue-runtime-selector");
    await expect(runtimeSelector).toBeVisible();
    await runtimeSelector.click();
    await page.getByTestId("issue-runtime-model-trigger").click();

    const modelOptions = page.getByTestId("issue-runtime-model-options").getByRole("option");
    await expect(modelOptions).toHaveCount(8);
    expect(await modelOptions.allTextContents()).toEqual([
      "Agent default · gpt-5.5",
      "GPT-5.6-sol",
      "GPT-5.6-terra",
      "GPT-5.6-luna",
      "GPT-5.5",
      "GPT-5.4",
      "GPT-5.4 Mini",
      "GPT-5.2",
    ]);

    await page.screenshot({
      path: testInfo.outputPath("new-issue-runtime-model-menu-desktop.png"),
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const runtimePanel = page.getByTestId("issue-runtime-profile-panel");
    await expect(runtimePanel).toBeVisible();
    const [runtimePanelBox, modelOptionsBox] = await Promise.all([
      runtimePanel.boundingBox(),
      page.getByTestId("issue-runtime-model-options").boundingBox(),
    ]);
    for (const box of [runtimePanelBox, modelOptionsBox]) {
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
    await page.screenshot({
      path: testInfo.outputPath("new-issue-runtime-model-menu-mobile.png"),
      fullPage: false,
    });
  });

  test("surfaces Codex discovery errors alongside built-in fallback models", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Codex-Model-Discovery-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await page.route(`**/api/orgs/${organization.id}/adapters/codex_local/models`, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "model discovery unavailable" }),
      });
    });

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Discovery failure Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.5" },
      },
    });
    expect(agentRes.ok()).toBe(true);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();
    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await dialog.getByRole("button", { name: "No assignee", exact: true }).click();
    await page.getByRole("button", { name: /Discovery failure Agent/ }).click();

    const selectedAgentOption = page.locator("[data-inline-entity-option]").filter({ hasText: "Discovery failure Agent" });
    await selectedAgentOption.getByTestId("issue-runtime-selector").click();
    const modelsResponsePromise = page.waitForResponse((response) =>
      response.status() === 503
      && response.url().includes(`/api/orgs/${organization.id}/adapters/codex_local/models`),
    );
    await page.getByTestId("issue-runtime-model-trigger").click();
    await modelsResponsePromise;
    await expect(page.getByTestId("issue-runtime-model-discovery-error")).toHaveText(
      "Models unavailable; showing built-in defaults.",
    );
    await expect(page.getByTestId("issue-runtime-option-model-gpt-5.6-sol")).toBeVisible();
  });

  test("persists New Issue runtime overrides and applies them to the assigned run", async ({ page }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-issue-runtime-override-"));
    const commandPath = path.join(tempDir, "codex-runtime-override-stub");
    const capturePath = path.join(tempDir, "capture.json");
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.RUDDER_TEST_CAPTURE_PATH, JSON.stringify({
    argv: process.argv.slice(2),
    prompt,
  }), "utf8");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "issue-runtime-override-e2e" }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Issue runtime override applied." },
  }));
  console.log(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  }));
});
`;
    await fs.writeFile(commandPath, script, { mode: 0o755 });

    try {
      const orgRes = await page.request.post("/api/orgs", {
        data: {
          name: `Issue-Runtime-Override-${Date.now()}`,
        },
      });
      expect(orgRes.ok()).toBe(true);
      const organization = await orgRes.json() as { id: string; issuePrefix: string };

      const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
        data: {
          name: "Issue Override Agent",
          role: "engineer",
          title: "Coding Agent",
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
      }, organization.id);
      await page.goto(`/${organization.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });

      await page.getByTestId("workspace-main-header")
        .getByRole("button", { name: "Create Issue" })
        .click();
      const dialog = page.locator('[data-slot="dialog-content"]')
        .filter({ has: page.getByText("New issue") })
        .first();
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder("Issue title").fill("Run this issue with a local override");
      await dialog.getByRole("button", { name: "No assignee", exact: true }).click();
      await page.getByRole("button", { name: /Issue Override Agent/ }).click();
      const selectedAgentOption = page.locator("[data-inline-entity-option]").filter({ hasText: "Issue Override Agent" });
      const runtimeSelector = selectedAgentOption.getByTestId("issue-runtime-selector");
      await runtimeSelector.click();
      await page.getByTestId("issue-runtime-model-trigger").click();
      await page.getByTestId("issue-runtime-option-model-gpt-5.6-sol").click();
      await runtimeSelector.click();
      await page.getByTestId("issue-runtime-effort-trigger").click();
      await page.getByTestId("issue-runtime-option-effort-ultra").click();

      const createResponsePromise = page.waitForResponse((response) =>
        response.request().method() === "POST"
        && response.url().includes(`/api/orgs/${organization.id}/issues`),
      );
      await dialog.getByRole("button", { name: "Create Issue", exact: true }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.ok()).toBe(true);
      const issue = await createResponse.json() as {
        id: string;
        assigneeAgentId: string | null;
        assigneeAgentRuntimeOverrides: Record<string, unknown> | null;
      };
      expect(issue.assigneeAgentId).toBe(agent.id);
      expect(issue.assigneeAgentRuntimeOverrides).toEqual({
        agentRuntimeConfig: {
          model: "gpt-5.6-sol",
          modelReasoningEffort: "ultra",
        },
      });

      const persistedIssueRes = await page.request.get(`/api/issues/${issue.id}`);
      expect(persistedIssueRes.ok()).toBe(true);
      const persistedIssue = await persistedIssueRes.json() as {
        assigneeAgentRuntimeOverrides: Record<string, unknown> | null;
      };
      expect(persistedIssue.assigneeAgentRuntimeOverrides).toEqual(issue.assigneeAgentRuntimeOverrides);

      await expect.poll(async () => {
        try {
          await fs.access(capturePath);
          return true;
        } catch {
          return false;
        }
      }, {
        timeout: 20_000,
        intervals: [100, 250, 500, 1_000],
      }).toBe(true);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        prompt: string;
      };
      const modelIndex = capture.argv.indexOf("--model");
      const effortIndex = capture.argv.indexOf('model_reasoning_effort="ultra"');
      expect(capture.argv.slice(modelIndex, modelIndex + 2)).toEqual(["--model", "gpt-5.6-sol"]);
      expect(capture.argv[effortIndex - 1]).toBe("-c");
      expect(capture.argv).not.toContain("gpt-5.5");
      expect(capture.prompt).toContain("Run this issue with a local override");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("clears a selected model when switching the assigned Agent", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Agent-Switch-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentIds: Record<string, string> = {};
    for (const name of ["First model Agent", "Second model Agent"]) {
      const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
        data: {
          name,
          role: "engineer",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: { model: "gpt-5.5" },
        },
      });
      expect(agentRes.ok()).toBe(true);
      agentIds[name] = (await agentRes.json() as { id: string }).id;
    }

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();
    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await dialog.getByRole("button", { name: "No assignee", exact: true }).click();
    await page.getByRole("button", { name: /First model Agent/ }).click();

    const firstOption = page.locator("[data-inline-entity-option]").filter({ hasText: "First model Agent" });
    const firstRuntimeSelector = firstOption.getByTestId("issue-runtime-selector");
    await firstRuntimeSelector.click();
    await page.getByTestId("issue-runtime-model-trigger").click();
    await page.getByTestId("issue-runtime-option-model-gpt-5.6-sol").click();
    await expect(firstRuntimeSelector).toHaveAttribute("title", /Custom profile/);

    await dialog.getByPlaceholder("Search assignees...").fill("Second model Agent");
    await dialog.getByPlaceholder("Search assignees...").press("Enter");
    const secondOption = page.locator("[data-inline-entity-option]").filter({ hasText: "Second model Agent" });
    const secondRuntimeSelector = secondOption.getByTestId("issue-runtime-selector");
    await expect(secondRuntimeSelector).toBeVisible();
    await expect(secondRuntimeSelector).not.toHaveAttribute("title", /Custom profile/);

    await page.keyboard.press("Escape");
    await expect(dialog.getByPlaceholder("Search assignees...")).toBeHidden();
    await dialog.getByPlaceholder("Issue title").fill("Switching Agents must clear runtime overrides");
    const createResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/issues`),
    );
    await dialog.getByRole("button", { name: "Create Issue", exact: true }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    const createPayload = createResponse.request().postDataJSON() as {
      assigneeAgentId?: string;
      assigneeAgentRuntimeOverrides?: Record<string, unknown> | null;
    };
    expect(createPayload.assigneeAgentId).toBe(agentIds["Second model Agent"]);
    expect(createPayload.assigneeAgentRuntimeOverrides ?? null).toBeNull();
  });
});

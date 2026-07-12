import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test.describe("Codex model order", () => {
  test("shows newest Codex models first in New Issue overrides", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Codex-Model-Order-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

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
    await dialog.getByRole("button", { name: "Codex options", exact: true }).click();
    await dialog.getByRole("button", { name: "Default model", exact: true }).click();

    const modelOptions = page.locator(
      '[data-slot="popover-content"][data-state="open"] [data-inline-entity-option]',
    );
    await expect(modelOptions).toHaveCount(8);
    expect(await modelOptions.allTextContents()).toEqual([
      "Default model",
      "GPT-5.6-sol",
      "GPT-5.6-terra",
      "GPT-5.6-luna",
      "GPT-5.5",
      "GPT-5.4",
      "GPT-5.4 Mini",
      "GPT-5.2",
    ]);
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
      await dialog.getByRole("button", { name: "Codex options", exact: true }).click();
      await dialog.getByRole("button", { name: "Default model", exact: true }).click();
      await page.locator('[data-slot="popover-content"][data-state="open"]')
        .getByText("GPT-5.6-sol", { exact: true })
        .click();
      await dialog.getByRole("button", { name: "Ultra", exact: true }).click();

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
});

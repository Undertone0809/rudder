import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_HOME = path.resolve(THIS_DIR, ".tmp/rudder-e2e-home");
const E2E_CODEX_STUB = path.join(E2E_HOME, "bin", "codex");
const E2E_INSTANCE_ID = "playwright";

async function resolveSingleAgentWorkspaceRoot(orgId: string) {
  const agentsRoot = path.join(
    E2E_HOME,
    "instances",
    E2E_INSTANCE_ID,
    "organizations",
    orgId,
    "workspaces",
    "agents",
  );
  await expect.poll(async () => {
    try {
      return (await fs.readdir(agentsRoot)).length;
    } catch {
      return 0;
    }
  }).toBe(1);
  const entries = await fs.readdir(agentsRoot);
  expect(entries).toHaveLength(1);
  return path.join(agentsRoot, entries[0]!);
}

test.describe("Agent private skill creation", () => {
  test("lets users create an agent-private skill from the Agent Skills page", async ({ page }) => {
    const organizationName = `Org-Agent-Skill-Create-${Date.now()}`;
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Skill Author",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    await agentMain.getByRole("button", { name: "Create agent skill" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Agent Helper");
    await dialog.getByRole("textbox", { name: "Short name", exact: true }).fill("agent-helper");
    await dialog.getByRole("textbox", { name: "Description", exact: true }).fill("Private agent helper skill.");

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/agents/${agent.id}/skills/private`)
      && response.ok(),
    );
    await dialog.getByRole("button", { name: "Create skill" }).click();
    await createResponse;

    await expect(agentMain.getByText("Agent skills", { exact: true })).toBeVisible();
    await expect(agentMain.getByText("agent-helper")).toBeVisible();
    await expect(agentMain.getByText("Private agent helper skill.")).toBeVisible();

    const agentWorkspaceRoot = await resolveSingleAgentWorkspaceRoot(organization.id);
    const skillFilePath = path.join(agentWorkspaceRoot, "skills", "agent-helper", "SKILL.md");
    const skillMarkdown = await fs.readFile(skillFilePath, "utf8");
    expect(skillMarkdown).toContain("name: Agent Helper");
    expect(skillMarkdown).toContain("description: Private agent helper skill.");

    const enableSyncResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/agents/${agent.id}/skills/sync`)
      && response.ok(),
    );
    await agentMain.getByRole("switch", { name: "agent-helper" }).click();
    await enableSyncResponse;
    await expect(agentMain.getByRole("switch", { name: "agent-helper" })).toHaveAttribute("aria-checked", "true");
  });
});

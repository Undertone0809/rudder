import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_HOME = path.resolve(THIS_DIR, ".tmp/rudder-e2e-home");
const E2E_CODEX_STUB = path.join(E2E_HOME, "bin", "codex");

function organizationSkillMarkdownTarget(skill: { sourceLocator?: string | null; sourcePath?: string | null }) {
  const candidate = skill.sourceLocator ?? skill.sourcePath ?? null;
  if (!candidate) return null;
  return candidate.endsWith("/SKILL.md") || candidate.toLowerCase().endsWith(".md")
    ? candidate
    : `${candidate.replace(/\/$/, "")}/SKILL.md`;
}

test.describe("New issue skill mentions", () => {
  test("surfaces the current agent's enabled skills inside @ mention search", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Issue-Skill-Mentions-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Builder",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as {
      id: string;
      urlKey: string;
    };

    const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "Build Advisor",
        slug: "build-advisor",
        markdown: "---\nname: Build Advisor\ndescription: Diagnose what feels wrong before another blind iteration.\n---\n\n# Build Advisor\n",
      },
    });
    expect(skillRes.ok()).toBe(true);
    const skill = await skillRes.json() as {
      sourceLocator?: string | null;
      sourcePath?: string | null;
    };
    const skillTarget = organizationSkillMarkdownTarget(skill);
    expect(skillTarget).toBeTruthy();

    const syncRes = await page.request.post(`/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`, {
      data: {
        desiredSkills: ["build-advisor"],
      },
    });
    expect(syncRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}`);
    await expect(page.getByRole("button", { name: "Assign Task" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Assign Task" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    await dialog.getByPlaceholder("Issue title").fill("Use current agent skill mention");
    const composer = dialog.locator(".rudder-mdxeditor-content").first();
    await composer.fill("Use @advisor");

    const mentionMenu = page.getByTestId("markdown-mention-menu");
    await expect(mentionMenu).toBeVisible({ timeout: 15_000 });
    const skillOption = mentionMenu.locator('[data-testid^="markdown-mention-option-skill:"]').first();
    await expect(skillOption).toContainText("build-advisor");
    await skillOption.click();

    const insertedSkillToken = dialog.locator(".rudder-mdxeditor-content [data-skill-token='true']").first();
    await expect(insertedSkillToken).toBeVisible({ timeout: 15_000 });
    const insertedSkillLabel = (await insertedSkillToken.textContent())?.trim() ?? "";
    expect(insertedSkillLabel).toContain("build-advisor");
    expect(insertedSkillLabel).toContain(agent.urlKey);

    const createIssueResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/issues`)
      && response.ok(),
    );
    await dialog.getByRole("button", { name: "Create Issue" }).click();
    const createdIssueResponse = await createIssueResponse;
    const requestBody = createdIssueResponse.request().postDataJSON() as {
      description?: string;
    };

    expect(requestBody.description).toContain(`[${insertedSkillLabel}](${skillTarget})`);
  });
});

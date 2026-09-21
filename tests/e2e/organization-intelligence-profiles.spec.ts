import { expect, test } from "@playwright/test";

function uniqueIssuePrefix() {
  return ("I" + Date.now().toString(36).slice(-8)).toUpperCase().slice(0, 12);
}

test.describe("Organization intelligence profiles", () => {
  test("uses one Default model profile with Codex Luna Medium", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: "Intelligence Profiles " + Date.now(), issuePrefix: uniqueIssuePrefix() },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; id: string };

    try {
      await page.goto("/" + organization.issuePrefix + "/organization/settings");
      await page.getByRole("tab", { name: "Intelligence", exact: true }).click();

      const panel = page.getByTestId("organization-intelligence-profiles");
      await expect(panel).toBeVisible();
      const profile = page.getByTestId("intelligence-profile-default");
      await expect(profile).toBeVisible();
      await expect(page.getByTestId("intelligence-profile-lightweight")).toHaveCount(0);
      await expect(page.getByTestId("intelligence-profile-reasoning")).toHaveCount(0);
      await expect(profile.getByText("Default model", { exact: true })).toBeVisible();
      await expect(profile.getByRole("button", { name: /gpt-5\.6-luna/i })).toBeVisible();
      await expect(profile.getByRole("button", { name: "Medium", exact: true })).toBeVisible();

      const saveResponse = page.waitForResponse((response) =>
        response.request().method() === "PUT"
        && response.url().includes("/api/orgs/" + organization.id + "/intelligence-profiles/default")
        && response.ok(),
      );
      await profile.getByRole("button", { name: "Create", exact: true }).click();
      const saved = await (await saveResponse).json() as {
        purpose: string;
        agentRuntimeType: string;
        agentRuntimeConfig: Record<string, unknown>;
        status: string;
      };
      expect(saved.purpose).toBe("default");
      expect(saved.agentRuntimeType).toBe("codex_local");
      expect(saved.agentRuntimeConfig.model).toBe("gpt-5.6-luna");
      expect(saved.agentRuntimeConfig.modelReasoningEffort).toBe("medium");
      expect(saved.status).toBe("disabled");
    } finally {
      await page.request.delete("/api/orgs/" + organization.id);
    }
  });
});

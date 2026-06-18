import { expect, test } from "@playwright/test";

test.describe("Organization intelligence profiles", () => {
  test("creates a Fast profile from settings with a fallback chain", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Intelligence Profiles ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; id: string };

    let releaseFirstCodexProbe: (() => void) | null = null;
    const firstCodexProbeStarted = new Promise<void>((resolve) => {
      releaseFirstCodexProbe = resolve;
    });
    let delayedFirstCodexProbe = false;
    await page.route(`**/api/orgs/${organization.id}/adapters/*/test-environment`, async (route) => {
      const runtimeType = route.request().url().match(/\/adapters\/([^/]+)\/test-environment/)?.[1] ?? "unknown";
      if (runtimeType === "codex_local" && !delayedFirstCodexProbe) {
        delayedFirstCodexProbe = true;
        await firstCodexProbeStarted;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agentRuntimeType: runtimeType,
          status: "pass",
          testedAt: "2026-06-18T00:00:00.000Z",
          checks: [],
        }),
      });
    });
    let enabledLightweightProfile: Record<string, unknown> | null = null;
    await page.route(`**/api/orgs/${organization.id}/intelligence-profiles`, async (route) => {
      if (route.request().method() !== "GET" || !enabledLightweightProfile) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([enabledLightweightProfile, null]),
      });
    });
    await page.route(`**/api/orgs/${organization.id}/intelligence-profiles/lightweight`, async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON() as {
        agentRuntimeType?: string;
        agentRuntimeConfig?: Record<string, unknown>;
        status?: string;
      };
      if (body.status !== "configured") {
        await route.continue();
        return;
      }
      enabledLightweightProfile = {
        id: "profile-lightweight",
        orgId: organization.id,
        purpose: "lightweight",
        agentRuntimeType: body.agentRuntimeType,
        agentRuntimeConfig: body.agentRuntimeConfig,
        status: "configured",
        lastError: null,
        lastVerifiedAt: "2026-06-18T00:00:00.000Z",
        createdAt: "2026-06-18T00:00:00.000Z",
        updatedAt: "2026-06-18T00:00:00.000Z",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(enabledLightweightProfile),
      });
    });

    await page.goto(`/${organization.issuePrefix}/organization/settings`);

    const panel = page.getByTestId("organization-intelligence-profiles");
    await expect(panel).toBeVisible();

    const fast = page.getByTestId("intelligence-profile-lightweight");
    await expect(fast.getByText("Fast", { exact: true })).toBeVisible();
    await expect(fast.getByText("Not configured", { exact: true })).toBeVisible();
    await expect(fast.getByRole("button", { name: "GPT-5.4-Mini", exact: true })).toBeVisible();

    await fast.getByRole("button", { name: "Add fallback model" }).click();
    await expect(fast.getByText("Fallback 1", { exact: true })).toBeVisible();

    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && response.url().includes(`/api/orgs/${organization.id}/intelligence-profiles/lightweight`)
      && response.ok(),
    );
    await fast.getByRole("button", { name: "Create", exact: true }).click();
    const response = await saveResponse;
    const profile = await response.json() as {
      status: string;
      agentRuntimeConfig: Record<string, unknown>;
    };

    expect(profile.status).toBe("disabled");
    expect(profile.agentRuntimeConfig.model).toBe("gpt-5.4-mini");
    expect(profile.agentRuntimeConfig.modelFallbacks).toEqual([
      expect.objectContaining({
        agentRuntimeType: "claude_local",
      }),
    ]);
    expect(profile.agentRuntimeConfig).not.toHaveProperty("promptTemplate");
    expect(profile.agentRuntimeConfig).not.toHaveProperty("instructionsFilePath");
    expect(profile.agentRuntimeConfig).not.toHaveProperty("cwd");

    await expect(fast.getByText("Disabled", { exact: true })).toBeVisible();
    await expect(fast.getByText("Saved", { exact: true })).toBeVisible();
    await expect(fast.getByRole("button", { name: "Saved", exact: true })).toHaveCount(0);
    await expect(fast.getByText("Fallback 1", { exact: true })).toBeVisible();

    const enableResponse = page.waitForResponse((nextResponse) =>
      nextResponse.request().method() === "PUT"
      && nextResponse.url().includes(`/api/orgs/${organization.id}/intelligence-profiles/lightweight`)
      && nextResponse.ok(),
    );
    const testResponses = [
      page.waitForResponse((nextResponse) =>
        nextResponse.request().method() === "POST"
        && nextResponse.url().includes(`/api/orgs/${organization.id}/adapters/codex_local/test-environment`)
        && nextResponse.ok(),
      ),
      page.waitForResponse((nextResponse) =>
        nextResponse.request().method() === "POST"
        && nextResponse.url().includes(`/api/orgs/${organization.id}/adapters/claude_local/test-environment`)
        && nextResponse.ok(),
      ),
    ];
    await fast.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(fast.getByText("Testing...", { exact: true })).toBeVisible();

    const smart = page.getByTestId("intelligence-profile-reasoning");
    await expect(smart.getByRole("button", { name: "Test runtime chain", exact: true })).toBeEnabled();
    await expect(smart.getByRole("button", { name: "Add fallback model", exact: true })).toBeEnabled();
    const smartTestResponse = page.waitForResponse((nextResponse) => {
      if (
        nextResponse.request().method() !== "POST"
        || !nextResponse.url().includes(`/api/orgs/${organization.id}/adapters/codex_local/test-environment`)
        || !nextResponse.ok()
      ) {
        return false;
      }
      const body = nextResponse.request().postDataJSON() as {
        agentRuntimeConfig?: { model?: string };
      };
      return body.agentRuntimeConfig?.model === "gpt-5.4";
    });
    await smart.getByRole("button", { name: "Test runtime chain", exact: true }).click();
    await smartTestResponse;
    await expect(smart.getByText("Primary · Codex (local) · gpt-5.4: Passed")).toBeVisible();
    releaseFirstCodexProbe?.();

    await Promise.all(testResponses);
    const enabledProfile = await (await enableResponse).json() as { status: string };
    expect(enabledProfile.status).toBe("configured");
    await expect(fast.getByText("Runtime chain environment", { exact: true })).toBeVisible();
    await expect(fast.getByText("Enabled", { exact: true })).toBeVisible();
  });
});

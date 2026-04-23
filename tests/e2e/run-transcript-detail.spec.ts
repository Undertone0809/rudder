import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_HOME = path.resolve(THIS_DIR, ".tmp/rudder-e2e-home");
const E2E_CODEX_STUB = path.join(E2E_HOME, "bin", "codex");

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
        command: "/bin/true",
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

test.describe("Run transcript detail", () => {
  test("renders semantic timeline rows and expandable tool details", async ({ page }) => {
    const organization = await createOrganization(page, `Run-Detail-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/tests/ux/runs");

    await expect(page.getByRole("heading", { name: "Run Detail" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Show settled state" }).click();
    await expect(page.getByRole("button", { name: "Show streaming state" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Read", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Grep", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Script", { exact: true }).first()).toBeVisible();

    const failedCommandRow = page.locator("section").filter({ hasText: "Ran pnpm test:run" }).first();
    await expect(failedCommandRow).toBeVisible();
    await expect(failedCommandRow.getByText("sh: vitest: command not found")).toHaveCount(0);
    await expect(failedCommandRow.getByRole("button", { name: "Expand command details" })).toBeVisible();

    await page.getByRole("button", { name: "Expand tool details" }).first().click();
    await expect(page.getByText("Input", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Result", { exact: true }).first()).toBeVisible();

    await failedCommandRow.getByRole("button", { name: "Expand command details" }).click();
    await expect(failedCommandRow.getByText("sh: vitest: command not found")).toBeVisible();

    await page.screenshot({
      path: "tests/e2e/test-results/run-transcript-detail-expanded.png",
      fullPage: true,
    });
  });

  test("merges transcript and invocation into one card with tabs on the real run detail page", async ({ page }) => {
    const organization = await createOrganization(page, `Run-Detail-Agent-${Date.now()}`);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Transcript Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const runRes = await page.request.post(`/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`);
    expect(runRes.ok()).toBe(true);
    const run = await runRes.json();
    expect(run.id).toBeTruthy();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${run.id}`);

    const transcriptTab = page.getByRole("tab", { name: "Transcript" });
    const invocationTab = page.getByRole("tab", { name: "Invocation" });
    await expect(transcriptTab).toBeVisible({ timeout: 15_000 });
    await expect(invocationTab).toBeVisible({ timeout: 15_000 });
    await expect(transcriptTab).toHaveAttribute("data-state", "active");
    await expect(page.getByRole("button", { name: "nice" })).toBeVisible();
    await expect(page.getByText("adapter invocation")).toBeVisible();

    await invocationTab.click();
    await expect(invocationTab).toHaveAttribute("data-state", "active");
    await expect(page.getByText("Exact adapter invoke payload")).toBeHidden();
    await expect(page.getByText("Runtime:", { exact: false })).toBeVisible();
    await expect(page.getByText("Command:", { exact: false })).toBeVisible();
    await expect(page.getByText(/^Events \(\d+\)$/)).toBeVisible();
    await expect(page.getByText("adapter invocation")).toBeVisible();
    await expect(page.getByRole("button", { name: "nice" })).toBeHidden();

    await invocationTab.hover();
    await expect(page.getByText("Exact adapter invoke payload")).toBeVisible();

    await transcriptTab.click();
    await expect(transcriptTab).toHaveAttribute("data-state", "active");
    await expect(page.getByRole("button", { name: "nice" })).toBeVisible();

    await page.screenshot({
      path: "tests/e2e/test-results/agent-run-detail-tabs.png",
      fullPage: true,
    });
  });

  test("copies the full run id from the runs list without navigating away", async ({ page, baseURL }) => {
    const organization = await createOrganization(page, `Run-Copy-${Date.now()}`);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Run Copy Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const runRes = await page.request.post(`/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`);
    expect(runRes.ok()).toBe(true);
    const run = await runRes.json();
    expect(run.id).toBeTruthy();

    if (baseURL) {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    }

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${run.id}`);
    const urlBeforeCopy = new URL(page.url());

    const copyButton = page.getByRole("button", { name: `Copy run ID ${run.id.slice(0, 8)}` });
    await expect(copyButton).toBeVisible({ timeout: 15_000 });

    await copyButton.click();

    await expect(page.getByText("Run ID copied")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/agents/[^/]+/runs/${run.id}$`));
    const urlAfterCopy = new URL(page.url());
    expect(urlAfterCopy.origin).toBe(urlBeforeCopy.origin);
    expect(urlAfterCopy.pathname.endsWith(`/runs/${run.id}`)).toBe(true);
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(run.id);

    await page.screenshot({
      path: "tests/e2e/test-results/agent-run-id-copied.png",
      fullPage: true,
    });
  });
});

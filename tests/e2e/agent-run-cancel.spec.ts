import { expect, test } from "@playwright/test";
import { createDb } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

function isProcessAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("stops an active Run from its Issue and converges the process and UI", async ({ page }) => {
  test.setTimeout(120_000);
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Run-Stop-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };

  const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Run Stop Agent",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json() as { id: string };

  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Stop the active agent Run",
      description: "The Issue Stop control must terminate the runtime and converge immediately.",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agent.id,
    },
  });
  expect(issueResponse.ok()).toBe(true);
  const issue = await issueResponse.json() as { id: string; identifier: string | null };

  const readActiveRun = async () => {
    const response = await page.request.get(`/api/issues/${issue.id}/active-run`);
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ id: string; status: string; processPid?: number | null } | null>;
  };
  await expect.poll(async () => (await readActiveRun())?.status, {
    timeout: 30_000,
    intervals: [250, 500, 1_000],
  }).toBe("running");
  await expect.poll(async () => (await readActiveRun())?.processPid ?? 0, {
    timeout: 30_000,
    intervals: [250, 500, 1_000],
  }).toBeGreaterThan(0);
  const activeRun = await readActiveRun();
  expect(activeRun?.processPid).toBeGreaterThan(0);
  expect(isProcessAlive(activeRun?.processPid)).toBe(true);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`, {
    waitUntil: "domcontentloaded",
  });

  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stopButton).toBeVisible({ timeout: 20_000 });
  const cancelRequestPromise = page.waitForRequest((request) => (
    request.method() === "POST"
    && new URL(request.url()).pathname === `/api/agent-runs/${activeRun!.id}/cancel`
  ));
  const cancelResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/agent-runs/${activeRun!.id}/cancel`
  ));
  await stopButton.click();

  const [cancelRequest, cancelResponse] = await Promise.all([
    cancelRequestPromise,
    cancelResponsePromise,
  ]);
  expect((await cancelRequest.allHeaders()).origin).toBe(new URL(page.url()).origin);
  expect(cancelResponse.ok()).toBe(true);
  await expect(page.getByText("Run stopped", { exact: true })).toBeVisible();
  await expect(stopButton).toHaveCount(0);

  await expect.poll(async () => await readActiveRun(), {
    timeout: 15_000,
    intervals: [100, 250, 500],
  }).toBeNull();
  const runResponse = await page.request.get(`/api/agent-runs/${activeRun!.id}`);
  expect(runResponse.ok()).toBe(true);
  const stoppedRun = await runResponse.json() as { status: string };
  expect(stoppedRun.status).toBe("cancelled");
  expect(isProcessAlive(activeRun?.processPid)).toBe(false);
  const [persistedRun] = await (e2eDb as unknown as {
    $client: {
      unsafe: (
        query: string,
        params: unknown[],
      ) => Promise<Array<{ process_exited_at: Date | null }>>;
    };
  }).$client.unsafe(
    "select process_exited_at from heartbeat_runs where id = $1",
    [activeRun!.id],
  );
  expect(persistedRun?.process_exited_at).toBeTruthy();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect.poll(async () => await readActiveRun(), {
    timeout: 15_000,
    intervals: [100, 250, 500],
  }).toBeNull();
  if (process.env.RUDDER_RUN_STOP_SCREENSHOT) {
    await page.screenshot({ path: process.env.RUDDER_RUN_STOP_SCREENSHOT, fullPage: true });
  }

  await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/runs/${activeRun!.id}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByText("cancelled", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  if (process.env.RUDDER_RUN_STOP_COMPARISON_SCREENSHOT) {
    await page.screenshot({ path: process.env.RUDDER_RUN_STOP_COMPARISON_SCREENSHOT, fullPage: true });
  }
});

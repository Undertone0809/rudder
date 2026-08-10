import { expect, test } from "@playwright/test";

test("steers an active Issue Run through persisted feedback and one continuation", async ({ page }) => {
  test.setTimeout(180_000);

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Steer-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Issue Steer Worker",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Redirect active implementation",
      description: "The active run should continue from explicit operator feedback.",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agent.id,
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  const readActiveRun = async () => {
    const response = await page.request.get(`/api/issues/${issue.id}/active-run`);
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ id: string; status: string } | null>;
  };
  await expect.poll(async () => (await readActiveRun())?.status, {
    timeout: 30_000,
    intervals: [250, 500, 1_000],
  }).toBe("running");
  const initialRun = await readActiveRun();
  expect(initialRun).not.toBeNull();

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`, {
    waitUntil: "domcontentloaded",
  });

  const steerButton = page.getByTestId("issue-comment-steer");
  await expect(steerButton).toBeVisible({ timeout: 20_000 });
  const composer = page.locator('.chat-composer .rudder-milkdown-content [contenteditable="true"]').last();
  await composer.click();
  await page.keyboard.type("Keep compatibility and use the smaller migration.");
  if (process.env.RUDDER_ISSUE_STEER_SCREENSHOT) {
    await page.screenshot({
      path: process.env.RUDDER_ISSUE_STEER_SCREENSHOT.replace(/\.png$/i, "-ready.png"),
      fullPage: true,
    });
  }
  await steerButton.click();

  await expect(page.getByText("Keep compatibility and use the smaller migration.", { exact: true }))
    .toBeVisible({ timeout: 15_000 });

  const readRuns = async () => {
    const response = await page.request.get(
      `/api/orgs/${organization.id}/heartbeat-runs?agentId=${agent.id}&limit=20`,
    );
    expect(response.ok()).toBe(true);
    return response.json() as Promise<Array<{
      id: string;
      status: string;
      contextSnapshot?: Record<string, unknown> | null;
    }>>;
  };

  await expect.poll(async () => {
    const runs = await readRuns();
    const oldRun = runs.find((run) => run.id === initialRun!.id);
    const continuations = runs.filter((run) =>
      run.contextSnapshot?.wakeReason === "issue_comment_steer"
      && run.contextSnapshot?.steerRunId === initialRun!.id
    );
    return {
      oldStatus: oldRun?.status ?? null,
      continuationCount: continuations.length,
      continuationActive: continuations.some((run) => run.status === "queued" || run.status === "running"),
    };
  }, {
    timeout: 30_000,
    intervals: [250, 500, 1_000],
  }).toEqual({
    oldStatus: "cancelled",
    continuationCount: 1,
    continuationActive: true,
  });

  if (process.env.RUDDER_ISSUE_STEER_SCREENSHOT) {
    await page.screenshot({ path: process.env.RUDDER_ISSUE_STEER_SCREENSHOT, fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("issue-comment-steer")).toBeVisible({ timeout: 15_000 });
  if (process.env.RUDDER_ISSUE_STEER_SCREENSHOT) {
    await page.screenshot({
      path: process.env.RUDDER_ISSUE_STEER_SCREENSHOT.replace(/\.png$/i, "-mobile.png"),
      fullPage: true,
    });
  }

  const continuation = (await readRuns()).find((run) =>
    run.contextSnapshot?.wakeReason === "issue_comment_steer"
    && run.contextSnapshot?.steerRunId === initialRun!.id
  );
  if (continuation && (continuation.status === "queued" || continuation.status === "running")) {
    const cancelRes = await page.request.post(`/api/agent-runs/${continuation.id}/cancel`, { data: {} });
    expect(cancelRes.ok()).toBe(true);
  }
});

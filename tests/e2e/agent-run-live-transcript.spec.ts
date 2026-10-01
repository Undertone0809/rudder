import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("Run Detail reads retained output before completion and preserves it after refresh", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "rudder-live-transcript-"));
  const releasePath = path.join(directory, "release");
  const marker = `LIVE_TRANSCRIPT_${Date.now()}`;
  const orgResponse = await page.request.post("/api/orgs", { data: { name: `Live transcript ${Date.now()}` } });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json();
  const agentResponse = await page.request.post(`/api/orgs/${org.id}/agents`, {
    data: {
      name: "Live transcript inspector", role: "engineer", agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", `console.log(${JSON.stringify(marker)}); const fs=require("node:fs"); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)})){clearInterval(timer);process.exit(0)}},100); setTimeout(()=>process.exit(1),60000).unref();`],
      },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json();
  let runId: string | undefined;
  try {
    const issueResponse = await page.request.post(`/api/orgs/${org.id}/issues`, {
      data: { title: "Inspect live transcript", status: "in_progress", priority: "high", assigneeAgentId: agent.id },
    });
    expect(issueResponse.ok()).toBe(true);
    const issue = await issueResponse.json();
    await expect.poll(async () => {
      const response = await page.request.get(`/api/issues/${issue.id}/active-run`);
      const run = await response.json();
      runId = run?.id;
      return run?.status;
    }, { timeout: 30_000 }).toBe("running");
    await expect.poll(async () => {
      const response = await page.request.get(`/api/run-intelligence/runs/${runId}/transcript`);
      return JSON.stringify(await response.json());
    }, { timeout: 20_000 }).toContain(marker);
    await page.goto("/");
    await page.evaluate((id) => localStorage.setItem("rudder.selectedOrganizationId", id), org.id);
    await page.goto(`/${org.urlKey}/agents/${agent.urlKey}/runs/${runId}`);
    const transcript = page.locator(".run-detail-container");
    await expect(transcript).toContainText(marker);
    await expect(transcript).not.toContainText("Transcript missing.");
    await page.reload();
    await expect(transcript).toContainText(marker);
    await page.screenshot({ path: testInfo.outputPath("live-run-transcript.png"), fullPage: true });
    await writeFile(releasePath, "release");
    await expect.poll(async () => {
      const response = await page.request.get(`/api/agent-runs/${runId}`);
      return (await response.json()).status;
    }, { timeout: 30_000 }).toBe("succeeded");
    await page.reload();
    await expect(transcript).toContainText(marker);
    await expect(transcript).not.toContainText("Transcript missing.");
    await page.screenshot({ path: testInfo.outputPath("completed-run-transcript.png"), fullPage: true });
  } finally {
    await writeFile(releasePath, "release");
  }
});

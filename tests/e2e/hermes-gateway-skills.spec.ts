import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("syncs Hermes Gateway skills from the Agent page into each new Run", async ({ page }) => {
  const marker = "R6Z182_HERMES_E2E_MARKER";
  const submittedInputs: string[] = [];
  let runCounter = 0;
  const hermes = createServer(async (req, res) => {
    if (req.url === "/api/sessions" && req.method === "POST") {
      return json(res, 201, { object: "hermes.session", session: { id: "hermes-e2e-session" } });
    }
    if (req.url === "/api/sessions/hermes-e2e-session" && req.method === "GET") {
      return json(res, 200, { object: "hermes.session", session: { id: "hermes-e2e-session" } });
    }
    if (req.url === "/api/sessions/hermes-e2e-session/messages" && req.method === "GET") {
      return json(res, 200, { object: "list", session_id: "hermes-e2e-session", data: [] });
    }
    if (req.url === "/v1/runs" && req.method === "POST") {
      expect(req.headers.authorization).toBe("Bearer hermes-e2e-key");
      submittedInputs.push(String((await readJsonBody(req)).input ?? ""));
      runCounter += 1;
      return json(res, 202, { run_id: `hermes-e2e-run-${runCounter}`, status: "started" });
    }
    if (req.url?.startsWith("/v1/runs/hermes-e2e-run-") && req.url.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ event: "run.completed", output: "ok" })}\n\n`);
      return;
    }
    json(res, 404, { error: `unexpected ${req.method} ${req.url}` });
  });
  await new Promise<void>((resolve) => hermes.listen(0, "127.0.0.1", resolve));
  const address = hermes.address();
  if (!address || typeof address === "string") throw new Error("Hermes E2E server did not bind");

  try {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Hermes-Skills-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "Hermes Runtime Marker",
        slug: "hermes-runtime-marker",
        markdown: `---\nname: hermes-runtime-marker\ndescription: Hermes runtime projection test.\n---\n\n# Hermes Runtime Marker\n\n${marker}\n`,
      },
    });
    expect(skillRes.ok()).toBe(true);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Hermes Skill Agent",
        role: "engineer",
        agentRuntimeType: "hermes_gateway",
        agentRuntimeConfig: {
          url: `http://127.0.0.1:${address.port}`,
          apiKey: "hermes-e2e-key",
          timeoutMs: 5_000,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder:agent-skills:onboarding:v1", "dismissed");
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);

    const main = page.locator("#main-content");
    await expect(main.getByText("Rudder cannot manage skills for this runtime yet.")).toHaveCount(0);
    const skillSwitch = main.getByRole("switch", { name: "hermes-runtime-marker" });
    await expect(skillSwitch).toHaveAttribute("aria-checked", "false");

    const enableResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/agents/${agent.id}/skills/sync`),
    );
    await skillSwitch.click();
    expect((await enableResponse).ok()).toBe(true);
    await expect(skillSwitch).toHaveAttribute("aria-checked", "true");
    await page.reload();
    const persistedEnabledSwitch = main.getByRole("switch", { name: "hermes-runtime-marker" });
    await expect(persistedEnabledSwitch).toHaveAttribute("aria-checked", "true");
    await persistedEnabledSwitch.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/r6z-182-hermes-skills-enabled.png" });

    const firstRun = await page.request.post(`/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`);
    expect(firstRun.ok()).toBe(true);
    await expect.poll(() => submittedInputs.length, { timeout: 45_000 }).toBe(1);
    expect(submittedInputs[0]).toContain(marker);

    const refreshedSwitch = main.getByRole("switch", { name: "hermes-runtime-marker" });
    const disableResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/agents/${agent.id}/skills/sync`),
    );
    await refreshedSwitch.click();
    expect((await disableResponse).ok()).toBe(true);
    await expect(refreshedSwitch).toHaveAttribute("aria-checked", "false");
    await page.reload();
    const persistedDisabledSwitch = main.getByRole("switch", { name: "hermes-runtime-marker" });
    await expect(persistedDisabledSwitch).toHaveAttribute("aria-checked", "false");
    await persistedDisabledSwitch.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/r6z-182-hermes-skills-disabled.png" });

    const secondRun = await page.request.post(`/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`);
    expect(secondRun.ok()).toBe(true);
    await expect.poll(() => submittedInputs.length, { timeout: 45_000 }).toBe(2);
    expect(submittedInputs[1]).not.toContain(marker);
  } finally {
    await new Promise<void>((resolve, reject) => hermes.close((error) => error ? reject(error) : resolve()));
  }
});

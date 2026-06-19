import { expect, test } from "@playwright/test";

function shortRefFor(kind: "agent" | "issue_comment", id: string) {
  const prefix = kind === "agent" ? "agt" : "cmt";
  return `${prefix}_${id.replace(/-/g, "").toLowerCase().slice(0, 8)}`;
}

test("agent-authored issue comments wake peers only with wake-intent agent links", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Agent-Wake-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string };

  const authorAgentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Morgan",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(authorAgentRes.ok()).toBe(true);
  const authorAgent = await authorAgentRes.json() as { id: string };

  const targetAgentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Dylan",
      role: "pm",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(targetAgentRes.ok()).toBe(true);
  const targetAgent = await targetAgentRes.json() as { id: string; name: string };

  const authorKeyRes = await page.request.post(`/api/agents/${authorAgent.id}/keys`, {
    data: { name: "issue-comment-agent-wake-e2e" },
  });
  expect(authorKeyRes.ok()).toBe(true);
  const authorKey = await authorKeyRes.json() as { token: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Agent-authored comment wake target",
      description: "Agent comments should use the same wake-intent link contract as board comments.",
      status: "todo",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string };

  const mentionWakeRuns = async () => {
    const runsRes = await page.request.get(`/api/orgs/${organization.id}/heartbeat-runs?agentId=${targetAgent.id}&limit=20`);
    expect(runsRes.ok()).toBe(true);
    const runs = await runsRes.json() as Array<{ contextSnapshot?: Record<string, unknown> | null }>;
    return runs.filter((run) =>
      run.contextSnapshot?.wakeReason === "issue_comment_mentioned"
      && run.contextSnapshot?.wakeSource === "comment.mention"
    );
  };

  const beforeReferenceOnly = (await mentionWakeRuns()).length;
  const referenceOnlyRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: { body: `[${targetAgent.name}](agent://${targetAgent.id}) is a reference only.` },
    headers: { authorization: `Bearer ${authorKey.token}` },
  });
  expect(referenceOnlyRes.ok()).toBe(true);
  await expect.poll(async () => (await mentionWakeRuns()).length, {
    timeout: 5_000,
    intervals: [250, 500, 1_000],
  }).toBe(beforeReferenceOnly);

  const plainTextRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: { body: `${targetAgent.name} is plain text, not a wake request.` },
    headers: { authorization: `Bearer ${authorKey.token}` },
  });
  expect(plainTextRes.ok()).toBe(true);
  await expect.poll(async () => (await mentionWakeRuns()).length, {
    timeout: 5_000,
    intervals: [250, 500, 1_000],
  }).toBe(beforeReferenceOnly);

  const wakeCommentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: { body: `[${targetAgent.name}](agent://${shortRefFor("agent", targetAgent.id)}?intent=wake) can you check the runtime handoff?` },
    headers: { authorization: `Bearer ${authorKey.token}` },
  });
  expect(wakeCommentRes.ok()).toBe(true);
  const wakeComment = await wakeCommentRes.json() as { id: string; body: string; shortRef?: string };
  expect(wakeComment.body).toContain(`agent://${targetAgent.id}?intent=wake`);
  expect(wakeComment.body).not.toContain(`agent://${shortRefFor("agent", targetAgent.id)}?intent=wake`);
  expect(wakeComment.shortRef).toBe(shortRefFor("issue_comment", wakeComment.id));

  await expect.poll(async () => {
    const runs = await mentionWakeRuns();
    return runs.filter((run) => run.contextSnapshot?.commentId === wakeComment.id).length;
  }, {
    timeout: 15_000,
    intervals: [250, 500, 1_000],
  }).toBeGreaterThan(0);

  const contextRes = await page.request.get(
    `/api/issues/${issue.id}/heartbeat-context?wakeCommentId=${encodeURIComponent(shortRefFor("issue_comment", wakeComment.id))}`,
  );
  expect(contextRes.ok()).toBe(true);
  const context = await contextRes.json() as { wakeComment?: { id: string; shortRef?: string } | null };
  expect(context.wakeComment?.id).toBe(wakeComment.id);
  expect(context.wakeComment?.shortRef).toBe(shortRefFor("issue_comment", wakeComment.id));
});

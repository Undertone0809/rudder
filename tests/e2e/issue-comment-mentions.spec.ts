import { expect, test } from "@playwright/test";

test("explicit assignee and reviewer mentions work without lifecycle rollback", async ({ page }) => {
  test.setTimeout(120_000);
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Status-Independent-Mentions-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string };

  const createAgent = async (name: string) => {
    const response = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name,
        role: "engineer",
        agentRuntimeType: "process",
        agentRuntimeConfig: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      },
    });
    expect(response.ok()).toBe(true);
    return await response.json() as { id: string; name: string };
  };
  const mentionRuns = async (agentId: string, issueId: string) => {
    const response = await page.request.get(
      `/api/orgs/${organization.id}/heartbeat-runs?agentId=${agentId}&limit=50`,
    );
    expect(response.ok()).toBe(true);
    const runs = await response.json() as Array<{
      contextSnapshot?: Record<string, unknown> | null;
    }>;
    return runs.filter((run) =>
      run.contextSnapshot?.issueId === issueId
      && run.contextSnapshot?.wakeReason === "issue_comment_mentioned"
      && run.contextSnapshot?.wakeSource === "comment.mention"
    );
  };
  const waitForInitialIssueWakesToSettle = async (issueId: string, assigneeAgentId: string) => {
    await expect.poll(async () => {
      const [issueResponse, runsResponse] = await Promise.all([
        page.request.get(`/api/issues/${issueId}`),
        page.request.get(
          `/api/orgs/${organization.id}/heartbeat-runs?agentId=${assigneeAgentId}&limit=50`,
        ),
      ]);
      expect(issueResponse.ok()).toBe(true);
      expect(runsResponse.ok()).toBe(true);
      const issueState = await issueResponse.json() as { executionRunId: string | null };
      const runs = await runsResponse.json() as Array<{
        status: string;
        contextSnapshot?: Record<string, unknown> | null;
      }>;
      const initialIssueRuns = runs.filter((run) =>
        run.contextSnapshot?.issueId === issueId
        && run.contextSnapshot?.wakeSource !== "comment.mention"
      );
      return {
        hasTerminalInitialWake: initialIssueRuns.some((run) =>
          ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)
        ),
        hasActiveInitialWake: initialIssueRuns.some((run) =>
          run.status === "queued" || run.status === "running"
        ),
        executionRunId: issueState.executionRunId,
      };
    }, {
      timeout: 30_000,
      intervals: [250, 500, 1_000],
    }).toEqual({
      hasTerminalInitialWake: true,
      hasActiveInitialWake: false,
      executionRunId: null,
    });
  };

  for (const status of ["in_review", "done", "cancelled"] as const) {
    const assignee = await createAgent(`Explicit Assignee ${status}`);
    const reviewer = await createAgent(`Explicit Reviewer ${status}`);

    for (const [agent, relationship] of [
      [assignee, "assignee"],
      [reviewer, "reviewer"],
    ] as const) {
      const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
        data: {
          title: `Explicit ${relationship} work remains available in ${status}`,
          description: "Status must remain a lifecycle signal rather than an explicit-work permission gate.",
          status,
          priority: "medium",
          assigneeAgentId: assignee.id,
          reviewerAgentId: reviewer.id,
        },
      });
      expect(issueRes.ok()).toBe(true);
      const issue = await issueRes.json() as { id: string };
      await waitForInitialIssueWakesToSettle(issue.id, assignee.id);

      const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
        data: {
          body: `[@${agent.name}](agent://${agent.id}?intent=wake) please verify explicit work in ${status}.`,
        },
      });
      expect(commentRes.ok()).toBe(true);

      await expect.poll(async () => (await mentionRuns(agent.id, issue.id)).length, {
        timeout: 20_000,
        intervals: [250, 500, 1_000],
      }).toBe(1);
      const [run] = await mentionRuns(agent.id, issue.id);
      expect(run.contextSnapshot).toMatchObject({
        issueId: issue.id,
        relationship,
        issue: {
          status,
          assigneeAgentId: assignee.id,
          reviewerAgentId: reviewer.id,
        },
      });

      const currentIssueRes = await page.request.get(`/api/issues/${issue.id}`);
      expect(currentIssueRes.ok()).toBe(true);
      const currentIssue = await currentIssueRes.json() as {
        status: string;
        assigneeAgentId: string | null;
        reviewerAgentId: string | null;
      };
      expect(currentIssue).toMatchObject({
        status,
        assigneeAgentId: assignee.id,
        reviewerAgentId: reviewer.id,
      });
    }
  }
});

test("issue comment composer uses the chat-style mention panel without exposing mention URLs", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Mentions-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
    data: {
      name: "mention-project",
      status: "in_progress",
      color: "#0ea5e9",
    },
  });
  expect(projectRes.ok()).toBe(true);
  const project = await projectRes.json() as { id: string; name: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
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
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string; name: string };

  const primaryIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Primary issue for comment mentions",
      description: "The comment composer should handle @ mentions like new chat.",
      status: "todo",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(primaryIssueRes.ok()).toBe(true);
  const primaryIssue = await primaryIssueRes.json() as { id: string; identifier: string | null };

  const relatedIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Related mention target",
      description: "This issue appears in the mention picker with metadata.",
      status: "todo",
      priority: "medium",
      projectId: project.id,
      assigneeAgentId: agent.id,
    },
  });
  expect(relatedIssueRes.ok()).toBe(true);
  const relatedIssue = await relatedIssueRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.setViewportSize({ width: 1440, height: 720 });
  await page.goto(`/${organization.issuePrefix}/issues/${primaryIssue.identifier ?? primaryIssue.id}`);

  await page.getByText("The comment composer should handle @ mentions like new chat.").click();
  const descriptionEditor = page.locator('.rudder-milkdown-scope .ProseMirror[contenteditable="true"]').first();
  await expect(descriptionEditor).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");

  const composer = page.locator('.rudder-milkdown-scope .ProseMirror[contenteditable="true"]').last();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.evaluate((node) => {
    node.scrollIntoView({ block: "end", inline: "nearest" });
  });
  await page.waitForTimeout(50);

  await composer.click();
  await page.keyboard.type("@rel");

  const mentionMenu = page.getByTestId("markdown-mention-menu");
  await expect(mentionMenu).toBeVisible();
  await expect(mentionMenu).toContainText("Issues");
  await expect(mentionMenu).toContainText("Related mention target");

  const composerBox = await composer.boundingBox();
  const menuBox = await mentionMenu.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.width).toBeGreaterThan(composerBox!.width - 8);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(720 - 12);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(composerBox!.y - 8);

  await page.getByTestId(`markdown-mention-option-issue:${relatedIssue.id}`).click();
  await page.keyboard.type(" mouse");
  await expect(composer.locator(`a[href^="issue://${relatedIssue.id}"]`).first()).toContainText("Related mention target");
  await expect(composer).toContainText("Related mention target mouse");

  await composer.press("ControlOrMeta+A");
  await page.keyboard.type("before  after");
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  await page.keyboard.type("@dyl");
  await page.getByTestId(`markdown-mention-option-agent:${agent.id}`).click();
  await page.keyboard.type("next ");

  const agentChipLink = composer.locator(`a[href^="agent://${agent.id}"]`).first();
  await expect(agentChipLink).toBeVisible();
  await expect(agentChipLink).toContainText("Dylan");
  await expect(composer).toContainText(/before Dylan.*next\s+after/);

  await expect(page.locator('[class*="_linkDialogPopoverContent_"]')).toHaveCount(0);
  await expect(page.getByText(new RegExp(`agent://${agent.id}`))).toHaveCount(0);

  const mentionWakeRunsBeforeReferenceOnly = await page.request
    .get(`/api/orgs/${organization.id}/heartbeat-runs?agentId=${agent.id}&limit=20`)
    .then(async (res) => {
      expect(res.ok()).toBe(true);
      const runs = await res.json() as Array<{ contextSnapshot?: Record<string, unknown> | null }>;
      return runs.filter((run) =>
        run.contextSnapshot?.wakeReason === "issue_comment_mentioned"
        && run.contextSnapshot?.wakeSource === "comment.mention"
      ).length;
    });

  await agentChipLink.evaluate((anchor) => {
    const range = document.createRange();
    range.setStartAfter(anchor);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("Backspace");
  await expect(composer.locator(`a[href^="agent://${agent.id}"]`)).toHaveCount(0);

  const commentOnlyRes = await page.request.post(`/api/issues/${primaryIssue.id}/comments`, {
    data: { body: `[@${agent.name}](agent://${agent.id}) can you advise?` },
  });
  expect(commentOnlyRes.ok()).toBe(true);
  await expect.poll(async () => {
    const runsRes = await page.request.get(`/api/orgs/${organization.id}/heartbeat-runs?agentId=${agent.id}&limit=20`);
    expect(runsRes.ok()).toBe(true);
    const runs = await runsRes.json() as Array<{ contextSnapshot?: Record<string, unknown> | null }>;
    return runs.filter((run) =>
      run.contextSnapshot?.wakeReason === "issue_comment_mentioned"
      && run.contextSnapshot?.wakeSource === "comment.mention"
    ).length;
  }, {
    timeout: 5_000,
    intervals: [250, 500, 1_000],
  }).toBe(mentionWakeRunsBeforeReferenceOnly);
  const afterCommentOnlyRes = await page.request.get(`/api/issues/${primaryIssue.id}`);
  expect(afterCommentOnlyRes.ok()).toBe(true);
  const afterCommentOnly = await afterCommentOnlyRes.json() as {
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  };
  expect(afterCommentOnly.assigneeAgentId).toBeNull();
  expect(afterCommentOnly.assigneeUserId).toBe("local-board");

  const bareNameCommentRes = await page.request.post(`/api/issues/${primaryIssue.id}/comments`, {
    data: { body: `@${agent.name} can you advise?` },
  });
  expect(bareNameCommentRes.ok()).toBe(true);
  await expect.poll(async () => {
    const runsRes = await page.request.get(`/api/orgs/${organization.id}/heartbeat-runs?agentId=${agent.id}&limit=20`);
    expect(runsRes.ok()).toBe(true);
    const runs = await runsRes.json() as Array<{ contextSnapshot?: Record<string, unknown> | null }>;
    return runs.filter((run) =>
      run.contextSnapshot?.wakeReason === "issue_comment_mentioned"
      && run.contextSnapshot?.wakeSource === "comment.mention"
    ).length;
  }, {
    timeout: 5_000,
    intervals: [250, 500, 1_000],
  }).toBe(mentionWakeRunsBeforeReferenceOnly);

  const explicitReassignRes = await page.request.patch(`/api/issues/${primaryIssue.id}`, {
    data: {
      comment: `[${agent.name}](agent://${agent.id}) please own this.`,
      assigneeAgentId: agent.id,
      assigneeUserId: null,
    },
  });
  expect(explicitReassignRes.ok()).toBe(true);
  const afterExplicitReassign = await explicitReassignRes.json() as {
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  };
  expect(afterExplicitReassign.assigneeAgentId).toBe(agent.id);
  expect(afterExplicitReassign.assigneeUserId).toBeNull();
});

test("editing an issue comment wakes only agents newly mentioned by the edit", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Edit-Wake-Comment-Mention-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const firstAgentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Dylan Edit Wake",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(firstAgentRes.ok()).toBe(true);
  const firstAgent = await firstAgentRes.json() as { id: string; name: string };

  const secondAgentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Morgan Followup",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(secondAgentRes.ok()).toBe(true);
  const secondAgent = await secondAgentRes.json() as { id: string; name: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Edited comment mention wake",
      description: "A newly added mention should wake exactly that agent.",
      status: "todo",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: { body: "Initial feedback without an agent mention." },
  });
  expect(commentRes.ok()).toBe(true);
  const comment = await commentRes.json() as { id: string };

  const editMentionRuns = async (agentId: string) => {
    const runsRes = await page.request.get(`/api/orgs/${organization.id}/heartbeat-runs?agentId=${agentId}&limit=20`);
    expect(runsRes.ok()).toBe(true);
    const runs = await runsRes.json() as Array<{ contextSnapshot?: Record<string, unknown> | null }>;
    return runs.filter((run) =>
      run.contextSnapshot?.wakeReason === "issue_comment_mentioned"
      && run.contextSnapshot?.wakeSource === "comment.mention"
      && run.contextSnapshot?.commentId === comment.id
      && run.contextSnapshot?.mutation === "comment_edit"
    );
  };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const commentBlock = page.locator(`#comment-${comment.id}`);
  await expect(commentBlock).toBeVisible();
  const beginEdit = async () => {
    await commentBlock.getByRole("button", { name: "Comment actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editor = commentBlock.locator('.rudder-milkdown-content [contenteditable="true"]').first();
    await expect(editor).toBeVisible();
    return editor;
  };
  const saveEdit = async () => {
    const [response] = await Promise.all([
      page.waitForResponse((candidate) =>
        candidate.request().method() === "PATCH"
        && new URL(candidate.url()).pathname.endsWith(`/comments/${comment.id}`)),
      commentBlock.getByRole("button", { name: "Save" }).click(),
    ]);
    expect(response.ok()).toBe(true);
  };

  let editComposer = await beginEdit();
  await editComposer.click();
  await editComposer.press("End");
  await page.keyboard.type(" @dylan");
  const firstAgentOption = page.getByTestId(`markdown-mention-option-agent:${firstAgent.id}`);
  await expect(firstAgentOption).toBeVisible({ timeout: 15_000 });
  await firstAgentOption.click();
  await page.keyboard.type(" please review.");
  await saveEdit();

  await expect.poll(async () => (await editMentionRuns(firstAgent.id)).length, {
    timeout: 15_000,
    intervals: [250, 500, 1_000],
  }).toBe(1);
  const firstWake = (await editMentionRuns(firstAgent.id))[0];
  expect(firstWake.contextSnapshot?.comment).toEqual(expect.objectContaining({
    id: comment.id,
  }));

  editComposer = await beginEdit();
  await editComposer.click();
  await editComposer.press("End");
  await page.keyboard.type(" Additional context only.");
  await saveEdit();
  await page.waitForTimeout(1_000);
  expect(await editMentionRuns(firstAgent.id)).toHaveLength(1);

  editComposer = await beginEdit();
  await editComposer.click();
  await editComposer.press("End");
  await page.keyboard.type(" @morgan");
  const secondAgentOption = page.getByTestId(`markdown-mention-option-agent:${secondAgent.id}`);
  await expect(secondAgentOption).toBeVisible({ timeout: 15_000 });
  await secondAgentOption.click();
  await page.keyboard.type(" please join.");
  await saveEdit();

  await expect.poll(async () => (await editMentionRuns(secondAgent.id)).length, {
    timeout: 15_000,
    intervals: [250, 500, 1_000],
  }).toBe(1);
  await page.waitForTimeout(1_000);
  expect(await editMentionRuns(firstAgent.id)).toHaveLength(1);
  await expect(commentBlock.getByRole("link", { name: /Dylan Edit Wake/ })).toBeVisible();
  await expect(commentBlock.getByRole("link", { name: /Morgan Followup/ })).toBeVisible();
  await expect(commentBlock).toContainText("edited");
});

test("issue comment composer renders enough matching Library files for smooth menu scrolling", async ({ page }) => {
  const suffix = Date.now();
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Library-Comment-Mention-Scroll-${suffix}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Library mention scroll target",
      description: "The comment composer should show many matching Library files without paging.",
      status: "todo",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  const query = "scrolltarget";
  const directoryPath = `docs/mention-scroll-${suffix}`;
  const filePaths = Array.from({ length: 20 }, (_, index) => {
    const padded = String(index).padStart(2, "0");
    return `${directoryPath}/${query}-${padded}.md`;
  });
  for (const filePath of filePaths) {
    const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath,
        content: `# ${filePath}\n`,
      },
    });
    expect(fileRes.ok()).toBe(true);
  }

  const mentionFilesRes = await page.request.get(
    `/api/orgs/${organization.id}/workspace/mention-files?q=${encodeURIComponent(query)}&limit=50`,
  );
  expect(mentionFilesRes.ok()).toBe(true);
  const mentionFiles = await mentionFilesRes.json() as { entries: Array<{ path: string }> };
  expect(mentionFiles.entries).toHaveLength(filePaths.length);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.setViewportSize({ width: 1440, height: 720 });
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const composer = page.locator('.rudder-milkdown-scope .ProseMirror[contenteditable="true"]').last();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.evaluate((node) => {
    node.scrollIntoView({ block: "end", inline: "nearest" });
  });
  await page.waitForTimeout(50);

  await composer.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(`@${query}`);

  const mentionMenu = page.getByTestId("markdown-mention-menu");
  await expect(mentionMenu).toBeVisible({ timeout: 15_000 });
  await expect(mentionMenu).toContainText("Library");
  await expect(page.locator("[data-mention-option-index]")).toHaveCount(filePaths.length, {
    timeout: 15_000,
  });
  await expect(page.getByTestId(`markdown-mention-option-library-file:${filePaths[0]}`)).toBeVisible();
  await expect(page.getByTestId(`markdown-mention-option-library-file:${filePaths.at(-1)}`)).toBeAttached();

  const menuMetrics = await mentionMenu.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
  }));
  expect(menuMetrics.scrollHeight).toBeGreaterThan(menuMetrics.clientHeight);
});

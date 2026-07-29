import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  chatConversations,
  chatMessages,
  createDb,
  heartbeatRuns,
  issueComments,
  messengerCustomGroupEntries,
  messengerCustomGroups,
} from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL, E2E_INSTANCE_ROOT } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const CHAT_MESSAGE_COUNT = 2_000;
const ISSUE_COMMENT_COUNT = 500;
const TERMINAL_RUN_COUNT = 250;
const ACTIVE_RUN_COUNT = 2;
const MESSENGER_THREAD_COUNT = 698;

async function measureScrollFrames(page: Page, selector: string, durationMs: number) {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const readTaskDuration = async () => {
    const result = await session.send("Performance.getMetrics") as {
      metrics: Array<{ name: string; value: number }>;
    };
    return result.metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0;
  };
  const taskDurationBefore = await readTaskDuration();
  const frameMetrics = await page.locator(selector).evaluate(async (element, duration) => {
    const scrollElement = element as HTMLElement;
    const frameIntervals: number[] = [];
    const longTasks: number[] = [];
    let previousFrame = performance.now();
    let observer: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== "undefined") {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      try {
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        observer = null;
      }
    }

    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        frameIntervals.push(now - previousFrame);
        previousFrame = now;
        const progress = Math.min(1, (now - startedAt) / duration);
        const maxScroll = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
        scrollElement.scrollTop = maxScroll * progress;
        if (progress < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    observer?.disconnect();

    const sorted = [...frameIntervals].sort((left, right) => left - right);
    const percentile = (fraction: number) => sorted[Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * fraction) - 1),
    )] ?? 0;
    const droppedFrames = frameIntervals.reduce(
      (total, interval) => total + Math.max(0, Math.round(interval / 16.67) - 1),
      0,
    );
    return {
      durationMs: performance.now() - startedAt,
      frameCount: frameIntervals.length,
      droppedFrames,
      droppedFrameRatio: droppedFrames / Math.max(1, frameIntervals.length + droppedFrames),
      p95FrameIntervalMs: percentile(0.95),
      maxFrameIntervalMs: sorted.at(-1) ?? 0,
      longTaskCount: longTasks.length,
      longTaskTotalMs: longTasks.reduce((total, value) => total + value, 0),
      maxLongTaskMs: longTasks.length > 0 ? Math.max(...longTasks) : 0,
    };
  }, durationMs);
  const taskDurationAfter = await readTaskDuration();
  await session.detach();
  return {
    ...frameMetrics,
    rendererTaskDurationMs: (taskDurationAfter - taskDurationBefore) * 1_000,
  };
}

async function measureRuntimeFootprint(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  await session.send("HeapProfiler.collectGarbage");
  const [domCounters, performanceMetrics] = await Promise.all([
    session.send("Memory.getDOMCounters") as Promise<{
      documents: number;
      jsEventListeners: number;
      nodes: number;
    }>,
    session.send("Performance.getMetrics") as Promise<{
      metrics: Array<{ name: string; value: number }>;
    }>,
  ]);
  await session.detach();
  const metrics = new Map(performanceMetrics.metrics.map((metric) => [metric.name, metric.value]));
  return {
    documents: domCounters.documents,
    domNodes: domCounters.nodes,
    jsEventListeners: domCounters.jsEventListeners,
    jsHeapUsedMb: (metrics.get("JSHeapUsedSize") ?? 0) / (1024 * 1024),
    jsHeapTotalMb: (metrics.get("JSHeapTotalSize") ?? 0) / (1024 * 1024),
  };
}

async function measureMessengerFastScrollCoverage(page: Page) {
  return page.locator("[data-testid='workspace-sidebar'] nav").evaluate(async (element) => {
    const scrollElement = element as HTMLElement;
    const maxScroll = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    const targets = [0.02, 0.07].concat(Array.from({ length: 36 }, (_, index) => {
      const phase = index % 12;
      return phase < 6
        ? 0.12 + phase * 0.14
        : 0.82 - (phase - 6) * 0.14;
    }), [0.82, 0.68, 0.54, 0.4]);
    let blankSamples = 0;
    let maxBlankPx = 0;
    let samplesWithVisibleThreadRows = 0;
    const visibleGroupTestIds = new Set<string>();
    const samples: Array<{
      fraction: number;
      maxBlankPx: number;
      scrollTop: number;
      visibleCoverageCount: number;
    }> = [];

    for (const fraction of targets) {
      scrollElement.scrollTop = maxScroll * fraction;
      scrollElement.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const viewport = scrollElement.getBoundingClientRect();
      const coverageRows = Array.from(
        scrollElement.querySelectorAll<HTMLElement>(
          [
            "[data-messenger-thread-key]",
            "[data-messenger-scroll-coverage-row]",
          ].join(", "),
        ),
      )
        .map((row) => ({ row, rect: row.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.bottom);
      const visibleThreadRows = coverageRows.filter(({ row }) => (
        row.hasAttribute("data-messenger-thread-key")
      ));
      if (visibleThreadRows.length > 0) samplesWithVisibleThreadRows += 1;
      for (const { row } of visibleThreadRows) {
        const groupSurface = row.closest<HTMLElement>("[data-messenger-scroll-coverage-surface]");
        const groupTestId = groupSurface?.dataset.testid;
        if (groupTestId) visibleGroupTestIds.add(groupTestId);
      }
      const intervals = coverageRows
        .map(({ rect }) => ({
          start: Math.max(viewport.top, rect.top),
          end: Math.min(viewport.bottom, rect.bottom),
        }))
        .sort((left, right) => left.start - right.start);

      let cursor = viewport.top;
      let sampleMaxBlankPx = 0;
      for (const interval of intervals) {
        sampleMaxBlankPx = Math.max(sampleMaxBlankPx, interval.start - cursor);
        cursor = Math.max(cursor, interval.end);
      }
      sampleMaxBlankPx = Math.max(sampleMaxBlankPx, viewport.bottom - cursor);
      maxBlankPx = Math.max(maxBlankPx, sampleMaxBlankPx);
      // Normal row/group spacing is at most 16px. Anything larger is a
      // user-visible virtual-rendering hole rather than intentional layout.
      if (sampleMaxBlankPx > 16) blankSamples += 1;
      samples.push({
        fraction,
        maxBlankPx: sampleMaxBlankPx,
        scrollTop: scrollElement.scrollTop,
        visibleCoverageCount: intervals.length,
      });
    }

    return {
      blankSamples,
      maxBlankPx,
      sampleCount: targets.length,
      samplesWithVisibleThreadRows,
      samples,
      visibleGroupTestIds: Array.from(visibleGroupTestIds).sort(),
    };
  });
}

async function measureMessengerBidirectionalFling(page: Page, durationMs: number) {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const readTaskDuration = async () => {
    const result = await session.send("Performance.getMetrics") as {
      metrics: Array<{ name: string; value: number }>;
    };
    return result.metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0;
  };
  const taskDurationBefore = await readTaskDuration();
  const result = await page.locator("[data-testid='workspace-sidebar'] nav").evaluate(
    async (element, duration) => {
      const scrollElement = element as HTMLElement;
      const frameIntervals: number[] = [];
      const longTasks: number[] = [];
      const uncoveredPointCounts: number[] = [];
      let previousFrame = performance.now();
      let observer: PerformanceObserver | null = null;
      if (typeof PerformanceObserver !== "undefined") {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        try {
          observer.observe({ entryTypes: ["longtask"] });
        } catch {
          observer = null;
        }
      }

      const measureCoverage = () => {
        const viewport = scrollElement.getBoundingClientRect();
        const x = viewport.left + viewport.width / 2;
        const sampleFractions = [0.25, 0.5, 0.75];
        let uncoveredPoints = 0;
        for (const fraction of sampleFractions) {
          const y = viewport.top + viewport.height * fraction;
          const hit = document.elementFromPoint(x, y) as HTMLElement | null;
          const covered = Boolean(hit?.closest(
            "[data-messenger-thread-key], [data-messenger-scroll-coverage-row]",
          ));
          if (!covered) uncoveredPoints += 1;
        }
        return uncoveredPoints;
      };

      const startedAt = performance.now();
      const segmentDurationMs = 650;
      const lowFraction = 0.08;
      const highFraction = 0.92;
      const maxScroll = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
      let frameIndex = 0;
      let observedDirectionChanges = 0;
      let lastDirection = 0;
      let lastScrollTop = scrollElement.scrollTop;
      let minScrollTop = lastScrollTop;
      let maxScrollTop = lastScrollTop;
      await new Promise<void>((resolve) => {
        const step = (now: number) => {
          frameIntervals.push(now - previousFrame);
          previousFrame = now;
          // Sample the position painted by the previous frame, before writing
          // the next scroll offset. Sampling at 15Hz catches persistent visual
          // holes without forcing three synchronous hit tests on every frame.
          if (frameIndex % 4 === 0) {
            uncoveredPointCounts.push(measureCoverage());
          }
          frameIndex += 1;
          const elapsed = now - startedAt;
          const segment = Math.floor(elapsed / segmentDurationMs);
          const segmentProgress = Math.min(1, (elapsed % segmentDurationMs) / segmentDurationMs);
          const fraction = segment % 2 === 0
            ? lowFraction + (highFraction - lowFraction) * segmentProgress
            : highFraction - (highFraction - lowFraction) * segmentProgress;
          scrollElement.scrollTop = maxScroll * fraction;
          const nextScrollTop = scrollElement.scrollTop;
          const direction = Math.sign(nextScrollTop - lastScrollTop);
          if (direction !== 0) {
            if (lastDirection !== 0 && direction !== lastDirection) {
              observedDirectionChanges += 1;
            }
            lastDirection = direction;
          }
          lastScrollTop = nextScrollTop;
          minScrollTop = Math.min(minScrollTop, nextScrollTop);
          maxScrollTop = Math.max(maxScrollTop, nextScrollTop);
          if (elapsed < duration) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      observer?.disconnect();

      const sorted = [...frameIntervals].sort((left, right) => left - right);
      const percentile = (fraction: number) => sorted[Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * fraction) - 1),
      )] ?? 0;
      const droppedFrames = frameIntervals.reduce(
        (total, interval) => total + Math.max(0, Math.round(interval / 16.67) - 1),
        0,
      );
      return {
        durationMs: performance.now() - startedAt,
        frameCount: frameIntervals.length,
        directionChanges: observedDirectionChanges,
        maxScroll,
        minScrollTop,
        maxScrollTop,
        scrollSpanRatio: maxScroll > 0 ? (maxScrollTop - minScrollTop) / maxScroll : 0,
        droppedFrames,
        droppedFrameRatio: droppedFrames / Math.max(1, frameIntervals.length + droppedFrames),
        p95FrameIntervalMs: percentile(0.95),
        maxFrameIntervalMs: sorted.at(-1) ?? 0,
        longTaskCount: longTasks.length,
        longTaskTotalMs: longTasks.reduce((total, value) => total + value, 0),
        maxLongTaskMs: longTasks.length > 0 ? Math.max(...longTasks) : 0,
        largeBlankSampleCount: uncoveredPointCounts.filter((count) => count >= 2).length,
        fullBlankSampleCount: uncoveredPointCounts.filter((count) => count === 3).length,
        maxUncoveredPoints: uncoveredPointCounts.length > 0
          ? Math.max(...uncoveredPointCounts)
          : 0,
      };
    },
    durationMs,
  );
  const taskDurationAfter = await readTaskDuration();
  await session.detach();
  return {
    ...result,
    rendererTaskDurationMs: (taskDurationAfter - taskDurationBefore) * 1_000,
  };
}

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function insertGeneratedChunks<T>(
  count: number,
  createRow: (index: number) => T,
  insert: (rows: T[]) => Promise<unknown>,
) {
  for (let start = 0; start < count; start += 250) {
    const size = Math.min(250, count - start);
    await insert(Array.from({ length: size }, (_, offset) => createRow(start + offset)));
  }
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test("keeps whale Chat and Issue detail correct without terminal run-log fanout", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  const websocketUrls: string[] = [];
  let activeOrganizationWebSockets = 0;
  let maxConcurrentOrganizationWebSockets = 0;
  page.on("websocket", (socket) => {
    websocketUrls.push(socket.url());
    if (!new URL(socket.url()).pathname.endsWith("/events/ws")) return;
    activeOrganizationWebSockets += 1;
    maxConcurrentOrganizationWebSockets = Math.max(
      maxConcurrentOrganizationWebSockets,
      activeOrganizationWebSockets,
    );
    socket.on("close", () => {
      activeOrganizationWebSockets = Math.max(0, activeOrganizationWebSockets - 1);
    });
  });

  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Thread-Pressure-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };
  const sessionResponse = await page.request.get("/api/auth/get-session");
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json() as {
    session?: { userId?: string | null };
    user?: { id?: string | null };
  };
  const currentUserId = session.user?.id ?? session.session?.userId;
  expect(currentUserId).toBeTruthy();

  const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Thread Pressure Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        command: "codex",
        model: "gpt-5.4",
      },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json() as { id: string };

  const chatResponse = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Two thousand message pressure chat",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Disposable performance pressure seed." },
    },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json() as { id: string };

  const messengerBase = Date.now() - 60_000;
  const messengerThreadIds: string[] = [];
  await insertGeneratedChunks(
    MESSENGER_THREAD_COUNT,
    (index) => {
      const activityAt = new Date(messengerBase - index * 1_000);
      const id = randomUUID();
      messengerThreadIds.push(id);
      return {
        id,
        orgId: organization.id,
        title: `Disposable performance thread ${String(index + 1).padStart(3, "0")}`,
        summary: `Synthetic Messenger pressure row ${index + 1}.`,
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval" as const,
        planMode: false,
        createdByUserId: null,
        lastMessageAt: activityAt,
        createdAt: activityAt,
        updatedAt: activityAt,
      };
    },
    (rows) => e2eDb.insert(chatConversations).values(rows),
  );
  const pressureGroups = [
    { id: randomUUID(), name: "Pressure group A", sortOrder: 0 },
    { id: randomUUID(), name: "Pressure group B", sortOrder: 1 },
  ];
  await e2eDb.insert(messengerCustomGroups).values(pressureGroups.map((group) => ({
    ...group,
    orgId: organization.id,
    userId: currentUserId!,
    icon: "folder::slate",
  })));
  await e2eDb.insert(messengerCustomGroupEntries).values(
    messengerThreadIds.slice(0, 80).map((conversationId, index) => ({
      orgId: organization.id,
      userId: currentUserId!,
      groupId: pressureGroups[Math.floor(index / 40)]!.id,
      threadKey: `chat:${conversationId}`,
      sortOrder: index % 40,
    })),
  );

  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue with five hundred comments and two hundred fifty runs",
      description: "Browser-shaped single-entity pressure fixture.",
      status: "todo",
      priority: "high",
    },
  });
  expect(issueResponse.ok()).toBe(true);
  const issue = await issueResponse.json() as { id: string; identifier: string | null };

  const anchor = Date.parse("2026-07-20T00:00:00.000Z");
  await insertGeneratedChunks(
    CHAT_MESSAGE_COUNT,
    (index) => {
      const createdAt = new Date(anchor + Math.floor(index / 4) * 1_000);
      return {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        kind: "message" as const,
        status: "completed" as const,
        body: `Pressure chat message ${index + 1}. ${index % 7 === 0 ? "中文 emoji 🧭 and **markdown**. " : ""}${"context ".repeat(index % 20)}`,
        structuredPayload: index % 31 === 0 ? { benchmarkEvidence: { index } } : null,
        replyingAgentId: index % 2 === 0 ? null : agent.id,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => e2eDb.insert(chatMessages).values(rows),
  );

  const issueCommentIds: string[] = [];
  await insertGeneratedChunks(
    ISSUE_COMMENT_COUNT,
    (index) => {
      const createdAt = new Date(anchor + Math.floor(index / 4) * 1_000);
      const id = randomUUID();
      issueCommentIds.push(id);
      return {
        id,
        orgId: organization.id,
        issueId: issue.id,
        authorAgentId: index % 5 === 0 ? null : agent.id,
        authorUserId: index % 5 === 0 ? "local-board" : null,
        body: `Pressure issue comment ${index + 1}. ${"evidence ".repeat(index % 20)}`,
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => e2eDb.insert(issueComments).values(rows),
  );

  const terminalRunIds: string[] = [];
  const activeRunIds: string[] = [];
  const logRefByRunId = new Map<string, string>();
  await insertGeneratedChunks(
    TERMINAL_RUN_COUNT + ACTIVE_RUN_COUNT,
    (index) => {
      const id = randomUUID();
      const active = index >= TERMINAL_RUN_COUNT;
      const createdAt = active
        ? new Date(Date.now() + (index - TERMINAL_RUN_COUNT) * 1_000)
        : new Date(anchor + Math.floor(index / 4) * 1_000);
      (active ? activeRunIds : terminalRunIds).push(id);
      const hasPersistedLog = active || index === 0;
      const logRef = hasPersistedLog
        ? path.join(organization.id, agent.id, `${id}.ndjson`)
        : null;
      if (logRef) logRefByRunId.set(id, logRef);
      return {
        id,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "issue_assignment",
        triggerDetail: `pressure run ${index + 1}`,
        status: active ? "running" : "succeeded",
        startedAt: createdAt,
        finishedAt: active ? null : new Date(createdAt.getTime() + 30_000),
        stdoutExcerpt: `Pressure run ${index + 1} summary output.`,
        resultSummaryJson: active ? null : { summary: `Pressure result ${index + 1}` },
        logStore: logRef ? "local_file" : null,
        logRef,
        contextSnapshot: { issueId: issue.id, taskId: issue.id },
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => e2eDb.insert(heartbeatRuns).values(rows),
  );

  const terminalEvidence = `TERMINAL_RUN_EVIDENCE_${terminalRunIds[0]}`;
  for (const [runId, logRef] of logRefByRunId) {
    const absoluteLogPath = path.join(E2E_INSTANCE_ROOT, "data", "run-logs", logRef);
    await fs.mkdir(path.dirname(absoluteLogPath), { recursive: true });
    const evidence = runId === terminalRunIds[0]
      ? terminalEvidence
      : `ACTIVE_RUN_INITIAL_EVIDENCE_${runId}`;
    await fs.writeFile(absoluteLogPath, `${JSON.stringify({
      ts: new Date().toISOString(),
      stream: "stdout",
      chunk: `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: evidence },
      })}\n`,
    })}\n`, "utf8");
  }

  await selectOrganization(page, organization.id);

  const chatApiResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/chats/${chat.id}/messages`
  ));
  const chatStartedAt = Date.now();
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}?perfBaseline=1`);
  const chatApiResponse = await chatApiResponsePromise;
  expect(chatApiResponse.ok()).toBe(true);
  const chatPayload = await chatApiResponse.json() as unknown[];
  expect(chatPayload).toHaveLength(CHAT_MESSAGE_COUNT + 1);
  await expect(page.getByText(`Pressure chat message ${CHAT_MESSAGE_COUNT}.`, { exact: false })).toBeVisible({ timeout: 30_000 });
  const beforeChatReadyMs = Date.now() - chatStartedAt;
  const beforeChatDomMessages = await page.locator("[data-message-id]").count();
  const beforeChatScrollMetrics = await measureScrollFrames(
    page,
    "[data-testid='chat-messages-scroll-region']",
    5_000,
  );
  const beforeSidebarScrollMetrics = await measureScrollFrames(
    page,
    "[data-testid='workspace-sidebar'] nav",
    5_000,
  );
  await page.waitForTimeout(500);
  const beforeMountedMessengerRows = await page.locator("[data-messenger-thread-key]").count();
  const beforeRuntimeFootprint = await measureRuntimeFootprint(page);

  const optimizedStartedAt = Date.now();
  websocketUrls.length = 0;
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
  await expect(page.getByText(`Pressure chat message ${CHAT_MESSAGE_COUNT}.`, { exact: false })).toBeVisible({ timeout: 30_000 });
  const chatDomMessages = await page.locator("[data-message-id]").count();
  const chatVirtualRows = await page.locator("[data-virtualized-activity-key]").count();
  const chatReadyMs = Date.now() - optimizedStartedAt;
  expect(chatDomMessages).toBeLessThan(60);
  expect(chatVirtualRows).toBeLessThan(30);
  const chatScrollMetrics = await measureScrollFrames(page, "[data-testid='chat-messages-scroll-region']", 5_000);
  const sidebarScrollMetrics = await measureScrollFrames(
    page,
    "[data-testid='workspace-sidebar'] nav",
    5_000,
  );
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    await page.locator("[data-testid='workspace-sidebar'] nav").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(250);
  }
  await expect(page.getByTestId("messenger-thread-page-sentinel")).toHaveCount(0);
  await page.locator("[data-testid='workspace-sidebar'] nav").evaluate(async (element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  const pressureGroupA = page.getByTestId(
    `messenger-thread-section-custom-group-${pressureGroups[0]!.id}`,
  );
  await expect(pressureGroupA).toBeVisible({ timeout: 10_000 });
  const pressureGroupAToggle = pressureGroupA.getByRole("button", {
    name: pressureGroups[0]!.name,
    exact: true,
  });
  let groupPersistenceRequests = 0;
  let groupPersistenceResponses = 0;
  const groupPersistenceUrl = `**/api/orgs/${organization.id}/messenger/groups/${pressureGroups[0]!.id}`;
  await page.route(groupPersistenceUrl, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    groupPersistenceRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
    groupPersistenceResponses += 1;
  });
  await pressureGroupAToggle.click();
  expect(await pressureGroupA.getAttribute("data-collapsed")).toBe("true");
  const groupOpenFrame = await pressureGroupAToggle.evaluate(async (button) => {
    const startedAt = performance.now();
    (button as HTMLButtonElement).click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const groupRoot = button.closest<HTMLElement>("[data-collapsed]");
    const content = groupRoot?.querySelector<HTMLElement>("[data-messenger-group-content]");
    return {
      elapsedMs: performance.now() - startedAt,
      ariaHidden: content?.getAttribute("aria-hidden") ?? null,
      inert: content?.hasAttribute("inert") ?? null,
      visibleHeight: content?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(await pressureGroupA.getAttribute("data-collapsed")).toBe("false");
  expect(groupOpenFrame.elapsedMs).toBeLessThan(50);
  expect(groupOpenFrame.ariaHidden).toBeNull();
  expect(groupOpenFrame.inert).toBe(false);
  expect(groupOpenFrame.visibleHeight).toBeGreaterThan(0);
  await expect.poll(() => groupPersistenceRequests).toBe(2);
  await expect.poll(() => groupPersistenceResponses).toBe(2);
  await page.unroute(groupPersistenceUrl);
  for (const group of pressureGroups) {
    await expect(page.getByTestId(
      `messenger-section-virtual-entries-custom-group-${group.id}`,
    )).toHaveCount(1);
  }
  await expect(page.getByTestId("messenger-virtual-directory")).toHaveCount(1);
  const messengerFastScrollCoverage = await measureMessengerFastScrollCoverage(page);
  console.log(`THREAD_PRESSURE_FAST_SCROLL_COVERAGE ${JSON.stringify(messengerFastScrollCoverage)}`);
  const messengerBidirectionalFling = await measureMessengerBidirectionalFling(page, 6_000);
  console.log(`THREAD_PRESSURE_BIDIRECTIONAL_FLING ${JSON.stringify(messengerBidirectionalFling)}`);
  await page.screenshot({ path: "/tmp/rudder-thread-pressure-messenger.png" });
  expect(messengerFastScrollCoverage.blankSamples).toBe(0);
  expect(messengerFastScrollCoverage.maxBlankPx).toBeLessThanOrEqual(16);
  expect(messengerFastScrollCoverage.samplesWithVisibleThreadRows).toBe(
    messengerFastScrollCoverage.sampleCount,
  );
  expect(messengerFastScrollCoverage.visibleGroupTestIds).toEqual(
    pressureGroups.map((group) => (
      `messenger-thread-section-custom-group-${group.id}`
    )).sort(),
  );
  expect(messengerBidirectionalFling.directionChanges).toBeGreaterThanOrEqual(8);
  expect(messengerBidirectionalFling.maxScroll).toBeGreaterThan(1_000);
  expect(messengerBidirectionalFling.scrollSpanRatio).toBeGreaterThan(0.8);
  expect(messengerBidirectionalFling.largeBlankSampleCount).toBe(0);
  expect(messengerBidirectionalFling.fullBlankSampleCount).toBe(0);
  expect(messengerBidirectionalFling.maxUncoveredPoints).toBeLessThanOrEqual(1);
  expect(messengerBidirectionalFling.droppedFrameRatio).toBeLessThan(0.05);
  expect(messengerBidirectionalFling.p95FrameIntervalMs).toBeLessThan(20);
  expect(messengerBidirectionalFling.longTaskCount).toBe(0);
  await page.waitForTimeout(500);
  const mountedMessengerRows = await page.locator("[data-messenger-thread-key]").count();
  const genericOrganizationWebSockets = new Set(
    websocketUrls.filter((url) => new URL(url).pathname.endsWith("/events/ws")),
  );
  expect(genericOrganizationWebSockets.size).toBe(1);
  const loadedMessengerDirectoryHeight = await page.locator("[data-testid='messenger-virtual-directory']")
    .evaluate((element) => Number.parseFloat((element as HTMLElement).style.height) || 0);
  // Loaded rows in the rendered group window remain stable during scrolling;
  // paging and the outer directory still cap the overall DOM footprint.
  expect(mountedMessengerRows).toBeLessThan(160);
  const runtimeFootprint = await measureRuntimeFootprint(page);
  await page.screenshot({ path: "/tmp/rudder-thread-pressure-chat.png" });

  const requestedLogRunIds: string[] = [];
  const requestedLogRequests: Array<{ runId: string; at: number }> = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    const match = pathname.match(/^\/api\/agent-runs\/([^/]+)\/log$/u);
    if (request.method() === "GET" && match?.[1]) {
      requestedLogRunIds.push(match[1]);
      requestedLogRequests.push({ runId: match[1], at: Date.now() });
    }
  });

  const commentsResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/issues/${issue.identifier ?? issue.id}/comments`
  ));
  const runsResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/issues/${issue.identifier ?? issue.id}/runs`
  ));
  const issueStartedAt = Date.now();
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  const [commentsApiResponse, runsApiResponse] = await Promise.all([
    commentsResponsePromise,
    runsResponsePromise,
  ]);
  expect(commentsApiResponse.ok()).toBe(true);
  expect(runsApiResponse.ok()).toBe(true);
  expect(await commentsApiResponse.json()).toHaveLength(ISSUE_COMMENT_COUNT);
  expect(await runsApiResponse.json()).toHaveLength(TERMINAL_RUN_COUNT + ACTIVE_RUN_COUNT);
  const issueVirtualTimeline = page.getByTestId("comment-thread-virtual-timeline");
  await expect(issueVirtualTimeline).toBeVisible({ timeout: 30_000 });
  expect(await page.locator("[data-run-id]").count()).toBeLessThan(30);
  expect(await issueVirtualTimeline.locator("[data-virtualized-activity-key]").count()).toBeLessThan(30);
  const issueScroll = page.getByTestId("issue-detail-main-scroll");
  await issueScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText(`Pressure issue comment ${ISSUE_COMMENT_COUNT}.`, { exact: false })).toBeVisible({ timeout: 30_000 });
  const deepCommentId = issueCommentIds.at(-1);
  expect(deepCommentId).toBeTruthy();
  await page.evaluate((commentId) => {
    window.location.hash = `comment-${commentId}`;
  }, deepCommentId!);
  await expect(page.locator(`#comment-${deepCommentId}`)).toBeVisible({ timeout: 10_000 });
  const issueReadyMs = Date.now() - issueStartedAt;
  await page.waitForTimeout(2_500);

  const terminalRunIdSet = new Set(terminalRunIds);
  expect(requestedLogRunIds.filter((runId) => terminalRunIdSet.has(runId))).toEqual([]);
  const activeRunIdSet = new Set(activeRunIds);
  expect(new Set(requestedLogRunIds)).toEqual(activeRunIdSet);

  const activeIncrementalEvidence = "ACTIVE_RUN_INCREMENTAL_EVIDENCE";
  const activeLogRef = logRefByRunId.get(activeRunIds[0]!);
  expect(activeLogRef).toBeTruthy();
  await fs.appendFile(
    path.join(E2E_INSTANCE_ROOT, "data", "run-logs", activeLogRef!),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      stream: "stdout",
      chunk: `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: activeIncrementalEvidence },
      })}\n`,
    })}\n`,
    "utf8",
  );
  await expect(page.getByText(activeIncrementalEvidence, { exact: false })).toBeVisible({ timeout: 10_000 });

  await issueScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  const expandedTerminalRunId = terminalRunIds[0]!;
  const terminalLogRequest = page.waitForRequest((request) => (
    request.method() === "GET"
    && new URL(request.url()).pathname === `/api/agent-runs/${expandedTerminalRunId}/log`
  ));
  const terminalRow = page.locator(`[data-run-id="${expandedTerminalRunId}"]`);
  await terminalRow.getByRole("button", { name: "Show details" }).click();
  await terminalLogRequest;
  await expect(terminalRow.getByText(terminalEvidence, { exact: false })).toBeVisible({ timeout: 10_000 });
  expect(new Set(
    requestedLogRunIds.filter((runId) => terminalRunIdSet.has(runId)),
  )).toEqual(new Set([expandedTerminalRunId]));

  await terminalRow.getByRole("button", { name: "Hide details" }).click();
  await expect(terminalRow.getByRole("button", { name: "Show details" })).toBeVisible();
  await page.waitForTimeout(100);
  const terminalLogRequestAfterReopen = page.waitForRequest((request) => (
    request.method() === "GET"
    && new URL(request.url()).pathname === `/api/agent-runs/${expandedTerminalRunId}/log`
  ));
  await terminalRow.getByRole("button", { name: "Show details" }).click();
  await terminalLogRequestAfterReopen;
  await expect(terminalRow.getByText(terminalEvidence, { exact: false })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "/tmp/rudder-thread-pressure-issue.png" });

  const beforeMetrics = {
    chat: {
      apiRows: chatPayload.length,
      domMessages: beforeChatDomMessages,
      readyMs: beforeChatReadyMs,
      scroll: beforeChatScrollMetrics,
    },
    messenger: {
      seededThreads: MESSENGER_THREAD_COUNT + 1,
      mountedRows: beforeMountedMessengerRows,
      scroll: beforeSidebarScrollMetrics,
    },
    runtime: beforeRuntimeFootprint,
  };
  const afterMetrics = {
    chat: {
      apiRows: chatPayload.length,
      domMessages: chatDomMessages,
      virtualRows: chatVirtualRows,
      readyMs: chatReadyMs,
      scroll: chatScrollMetrics,
    },
    messenger: {
      seededThreads: MESSENGER_THREAD_COUNT + 1,
      mountedRows: mountedMessengerRows,
      directoryHeightPx: loadedMessengerDirectoryHeight,
      groupOpenFrameMs: groupOpenFrame.elapsedMs,
      scroll: sidebarScrollMetrics,
      bidirectionalFling: messengerBidirectionalFling,
    },
    realtime: {
      genericOrganizationWebSockets: genericOrganizationWebSockets.size,
    },
    issue: {
      comments: ISSUE_COMMENT_COUNT,
      terminalRuns: TERMINAL_RUN_COUNT,
      activeRuns: ACTIVE_RUN_COUNT,
      timelineRunRows: await page.locator("[data-run-id]").count(),
      readyMs: issueReadyMs,
      uniqueLogRequestsBeforeExpansion: [...new Set(requestedLogRunIds.filter((id) => id !== expandedTerminalRunId))].length,
      terminalLogRequestsAfterExpansion: requestedLogRunIds.filter((id) => terminalRunIdSet.has(id)),
    },
    runtime: runtimeFootprint,
  };
  await testInfo.attach("thread-pressure-before-metrics", {
    body: Buffer.from(JSON.stringify(beforeMetrics, null, 2)),
    contentType: "application/json",
  });
  await testInfo.attach("thread-pressure-after-metrics", {
    body: Buffer.from(JSON.stringify(afterMetrics, null, 2)),
    contentType: "application/json",
  });
  console.log(`THREAD_PRESSURE_BEFORE_METRICS ${JSON.stringify(beforeMetrics)}`);
  console.log(`THREAD_PRESSURE_AFTER_METRICS ${JSON.stringify(afterMetrics)}`);

  websocketUrls.length = 0;
  requestedLogRunIds.length = 0;
  requestedLogRequests.length = 0;
  const activeRunDetailId = activeRunIds[0]!;
  const activeRunDetailLogRequest = page.waitForRequest((request) => (
    request.method() === "GET"
    && new URL(request.url()).pathname === `/api/agent-runs/${activeRunDetailId}/log`
  ));
  const activeRunDetailLink = page.locator(
    `a[href$="/agents/${agent.id}/runs/${activeRunDetailId}"]`,
  ).first();
  await expect(activeRunDetailLink).toBeVisible();
  await activeRunDetailLink.click();
  await page.waitForURL(
    new RegExp(`/agents/${agent.id}/runs/${activeRunDetailId}(?:\\?|$)`, "u"),
  );
  await activeRunDetailLogRequest;
  await expect(page.getByText(`ACTIVE_RUN_INITIAL_EVIDENCE_${activeRunDetailId}`, { exact: false }))
    .toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(4_200);
  await page.screenshot({ path: "/tmp/rudder-thread-pressure-agent-run.png", fullPage: false });
  expect(maxConcurrentOrganizationWebSockets).toBe(1);
  const activeRunLogRequests = requestedLogRequests.filter(
    (request) => request.runId === activeRunDetailId,
  );
  expect(activeRunLogRequests.length).toBeGreaterThanOrEqual(3);
  expect(activeRunLogRequests.length).toBeLessThanOrEqual(4);
  for (let index = 1; index < activeRunLogRequests.length; index += 1) {
    expect(activeRunLogRequests[index]!.at - activeRunLogRequests[index - 1]!.at)
      .toBeGreaterThan(1_000);
  }

  const terminalTransitionEvidence = "ACTIVE_RUN_TERMINAL_EVIDENCE";
  await fs.appendFile(
    path.join(E2E_INSTANCE_ROOT, "data", "run-logs", activeLogRef!),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      stream: "stdout",
      chunk: `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: terminalTransitionEvidence },
      })}\n`,
    })}\n`,
    "utf8",
  );
  const cancelResponse = await page.request.post(`/api/agent-runs/${activeRunDetailId}/cancel`);
  expect(cancelResponse.ok()).toBe(true);
  await expect(page.getByText("cancelled", { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(terminalTransitionEvidence, { exact: false })).toBeVisible({
    timeout: 10_000,
  });
  const terminalRequestCount = requestedLogRequests.filter(
    (request) => request.runId === activeRunDetailId,
  ).length;
  await page.waitForTimeout(2_500);
  expect(requestedLogRequests.filter(
    (request) => request.runId === activeRunDetailId,
  )).toHaveLength(terminalRequestCount);
});

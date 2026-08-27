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

async function measureIssueActivityScrollCoverage(
  page: Page,
  scrollRoot: "issue-detail" | "document" = "issue-detail",
) {
  return page.getByTestId("issue-detail-main-scroll").evaluate(async (element, rootKind) => {
    const preferredScrollElement = element as HTMLElement;
    const scrollElement = rootKind === "document"
      ? document.scrollingElement as HTMLElement | null
      : preferredScrollElement;
    if (!scrollElement) throw new Error("Issue activity scroll root is missing");
    const timeline = scrollElement.querySelector<HTMLElement>(
      "[data-testid='comment-thread-virtual-timeline']",
    );
    if (!timeline) throw new Error("Issue activity virtual timeline is missing");
    const composer = scrollElement.querySelector<HTMLElement>(
      "[data-testid='comment-thread-fixed-composer']",
    );
    if (!composer) throw new Error("Issue activity composer is missing");
    const mobileNavigation = rootKind === "document"
      ? document.querySelector<HTMLElement>("nav[aria-label='Mobile navigation']")
      : null;
    if (rootKind === "document" && !mobileNavigation) {
      throw new Error("Mobile navigation is missing");
    }

    const timelineTop = timeline.getBoundingClientRect().top
      - (rootKind === "document" ? 0 : scrollElement.getBoundingClientRect().top)
      + scrollElement.scrollTop;
    const viewportHeight = rootKind === "document" ? window.innerHeight : scrollElement.clientHeight;
    const timelineScrollSpan = Math.max(0, timeline.offsetHeight - viewportHeight);
    const targets = [0.04, 0.82, 0.18, 0.94, 0.35, 0.7, 0.1, 0.58];
    const samples: Array<{
      composerVisible: boolean;
      fraction: number;
      mountedRowCount: number;
      phase: "sync" | "animation-frame";
      scrollTop: number;
      visibleRowCount: number;
    }> = [];

    const sample = (fraction: number, phase: "sync" | "animation-frame") => {
      const viewport = rootKind === "document"
        ? { bottom: window.innerHeight, top: 0 }
        : scrollElement.getBoundingClientRect();
      const mountedRows = Array.from(
        timeline.querySelectorAll<HTMLElement>("[data-virtualized-activity-key]"),
      );
      const visibleRowCount = mountedRows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      }).length;
      const composerRect = composer.getBoundingClientRect();
      const navigationTop = mobileNavigation?.getBoundingClientRect().top ?? viewport.bottom;
      samples.push({
        composerVisible: composerRect.bottom > viewport.top
          && composerRect.top < viewport.bottom
          && composerRect.bottom <= navigationTop + 1,
        fraction,
        mountedRowCount: mountedRows.length,
        phase,
        scrollTop: scrollElement.scrollTop,
        visibleRowCount,
      });
    };

    for (const fraction of targets) {
      scrollElement.scrollTop = timelineTop + timelineScrollSpan * fraction;
      (rootKind === "document" ? window : scrollElement).dispatchEvent(new Event("scroll"));
      sample(fraction, "sync");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      sample(fraction, "animation-frame");
    }

    return {
      blankSamples: samples.filter((entry) => entry.visibleRowCount === 0),
      composerHiddenSamples: samples.filter((entry) => !entry.composerVisible),
      maxMountedRowCount: Math.max(...samples.map((entry) => entry.mountedRowCount)),
      sampleCount: samples.length,
      samples,
    };
  }, scrollRoot);
}

async function measureMessengerPrepaintLead(page: Page) {
  return page.locator("[data-testid='workspace-sidebar'] nav").evaluate(async (element) => {
    const scrollElement = element as HTMLElement;
    const viewportHeight = scrollElement.clientHeight;
    const maxScroll = Math.max(0, scrollElement.scrollHeight - viewportHeight);
    const deltas = [0.12, 0.35, 0.65].map((fraction) => viewportHeight * fraction);
    const samples: Array<{
      direction: "backward" | "forward";
      deltaPx: number;
      blankPx: number;
      prepaintLeadPx: number;
      scrollTop: number;
    }> = [];
    const boundaryJumpSamples: Array<{
      target: "end" | "start";
      blankPx: number;
      scrollTop: number;
    }> = [];

    const readMountedIntervals = () => {
      const viewport = scrollElement.getBoundingClientRect();
      const intervals = Array.from(scrollElement.querySelectorAll<HTMLElement>(
        "[data-messenger-thread-key], [data-messenger-scroll-coverage-row]",
      ))
        .map((row) => row.getBoundingClientRect())
        .filter((rect) => rect.bottom >= viewport.top - viewportHeight * 2
          && rect.top <= viewport.bottom + viewportHeight * 2)
        .map((rect) => ({ start: rect.top, end: rect.bottom }))
        .sort((left, right) => left.start - right.start);
      return { intervals, viewport };
    };

    const contiguousLead = (
      intervals: Array<{ start: number; end: number }>,
      boundary: number,
      direction: "backward" | "forward",
    ) => {
      if (direction === "forward") {
        let cursor = boundary;
        for (const interval of intervals) {
          if (interval.end < boundary) continue;
          if (interval.start - cursor > 16) break;
          cursor = Math.max(cursor, interval.end);
        }
        return Math.max(0, cursor - boundary);
      }
      let cursor = boundary;
      for (let index = intervals.length - 1; index >= 0; index -= 1) {
        const interval = intervals[index]!;
        if (interval.start > boundary) continue;
        if (cursor - interval.end > 16) break;
        cursor = Math.min(cursor, interval.start);
      }
      return Math.max(0, boundary - cursor);
    };

    const measureExistingRowsAfterScroll = (
      direction: "backward" | "forward",
      deltaPx: number,
    ) => {
      const before = readMountedIntervals();
      const beforeRows = new Set(Array.from(scrollElement.querySelectorAll<HTMLElement>(
        "[data-messenger-thread-key], [data-messenger-scroll-coverage-row]",
      )));
      const previousScrollTop = scrollElement.scrollTop;
      scrollElement.scrollTop = Math.max(0, Math.min(
        maxScroll,
        previousScrollTop + (direction === "forward" ? deltaPx : -deltaPx),
      ));
      if (Math.abs(scrollElement.scrollTop - previousScrollTop) < deltaPx * 0.9) return;
      const viewport = scrollElement.getBoundingClientRect();
      const intervals = Array.from(beforeRows)
        .map((row) => row.getBoundingClientRect())
        .map((rect) => ({
          start: Math.max(viewport.top, rect.top),
          end: Math.min(viewport.bottom, rect.bottom),
        }))
        .filter((interval) => interval.end > viewport.top && interval.start < viewport.bottom)
        .sort((left, right) => left.start - right.start);
      let cursor = viewport.top;
      let blankPx = 0;
      for (const interval of intervals) {
        blankPx = Math.max(blankPx, interval.start - cursor);
        cursor = Math.max(cursor, interval.end);
      }
      blankPx = Math.max(blankPx, viewport.bottom - cursor);
      const boundary = direction === "forward"
        ? before.viewport.bottom
        : before.viewport.top;
      const prepaintLeadPx = contiguousLead(before.intervals, boundary, direction);
      samples.push({
        direction,
        deltaPx,
        blankPx,
        prepaintLeadPx,
        scrollTop: scrollElement.scrollTop,
      });
    };

    const readVisibleBoundaryBlank = (target: "end" | "start") => {
      const viewport = scrollElement.getBoundingClientRect();
      const intervals = Array.from(scrollElement.querySelectorAll<HTMLElement>(
        "[data-messenger-thread-key], [data-messenger-scroll-coverage-row]",
      ))
        .map((row) => row.getBoundingClientRect())
        .map((rect) => ({
          start: Math.max(viewport.top, rect.top),
          end: Math.min(viewport.bottom, rect.bottom),
        }))
        .filter((interval) => interval.end > viewport.top && interval.start < viewport.bottom)
        .sort((left, right) => left.start - right.start);
      if (intervals.length === 0) return viewport.height;
      // At the physical start, fixed controls legitimately precede the first
      // virtual row; at the physical end, the list may naturally finish before
      // the viewport edge. Measure only gaps that can represent an unmounted
      // virtual row while still treating a completely absent range as blank.
      let cursor = target === "start" ? intervals[0]!.start : viewport.top;
      let blankPx = 0;
      for (const interval of intervals) {
        blankPx = Math.max(blankPx, interval.start - cursor);
        cursor = Math.max(cursor, interval.end);
      }
      return target === "start"
        ? Math.max(blankPx, viewport.bottom - cursor)
        : blankPx;
    };

    scrollElement.scrollTop = maxScroll * 0.14;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    scrollElement.scrollTop = maxScroll * 0.15;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    for (let cycle = 0; cycle < 4; cycle += 1) {
      for (const deltaPx of deltas) {
        measureExistingRowsAfterScroll("forward", deltaPx);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      scrollElement.scrollTop = maxScroll * 0.76;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      scrollElement.scrollTop = maxScroll * 0.75;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (const deltaPx of deltas) {
        measureExistingRowsAfterScroll("backward", deltaPx);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      scrollElement.scrollTop = maxScroll * 0.15;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    for (const [target, scrollTop] of [
      ["end", maxScroll],
      ["start", 0],
    ] as const) {
      scrollElement.scrollTop = maxScroll * 0.5;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      scrollElement.scrollTop = scrollTop;
      // Native scroll events run before paint. Dispatch synchronously so this
      // sample verifies the emergency range commit for a scrollbar/Home/End
      // jump without granting React an extra frame to fill the viewport.
      scrollElement.dispatchEvent(new Event("scroll"));
      boundaryJumpSamples.push({
        target,
        blankPx: readVisibleBoundaryBlank(target),
        scrollTop: scrollElement.scrollTop,
      });
    }
    const forwardSamples = samples.filter((sample) => sample.direction === "forward");
    const backwardSamples = samples.filter((sample) => sample.direction === "backward");
    return {
      viewportHeight,
      minPrepaintLeadPx: Math.min(...samples.map((sample) => sample.prepaintLeadPx)),
      minForwardPrepaintLeadPx: Math.min(
        ...forwardSamples.map((sample) => sample.prepaintLeadPx),
      ),
      minBackwardPrepaintLeadPx: Math.min(
        ...backwardSamples.map((sample) => sample.prepaintLeadPx),
      ),
      maxPrepaintDeficitPx: Math.max(
        ...samples.map((sample) => Math.max(0, sample.deltaPx - sample.prepaintLeadPx)),
      ),
      maxBlankPx: Math.max(...samples.map((sample) => sample.blankPx)),
      lateSamples: samples.filter((sample) => sample.blankPx > 16),
      maxBoundaryJumpBlankPx: Math.max(...boundaryJumpSamples.map((sample) => sample.blankPx)),
      boundaryJumpSamples,
      samples,
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
  await expect(page.getByTestId("messenger-virtual-directory")).toHaveCount(1);
  const messengerFastScrollCoverage = await measureMessengerFastScrollCoverage(page);
  console.log(`THREAD_PRESSURE_FAST_SCROLL_COVERAGE ${JSON.stringify(messengerFastScrollCoverage)}`);
  const messengerBidirectionalFling = await measureMessengerBidirectionalFling(page, 6_000);
  console.log(`THREAD_PRESSURE_BIDIRECTIONAL_FLING ${JSON.stringify(messengerBidirectionalFling)}`);
  const messengerPrepaintLead = await measureMessengerPrepaintLead(page);
  console.log(`THREAD_PRESSURE_PREPAINT_LEAD ${JSON.stringify(messengerPrepaintLead)}`);
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
  expect(messengerPrepaintLead.lateSamples).toEqual([]);
  expect(messengerPrepaintLead.maxBlankPx).toBeLessThanOrEqual(16);
  expect(messengerPrepaintLead.maxBoundaryJumpBlankPx).toBeLessThanOrEqual(16);
  expect(messengerPrepaintLead.minForwardPrepaintLeadPx).toBeGreaterThanOrEqual(
    messengerPrepaintLead.viewportHeight,
  );
  expect(messengerPrepaintLead.minBackwardPrepaintLeadPx).toBeGreaterThanOrEqual(
    messengerPrepaintLead.viewportHeight,
  );
  expect(messengerPrepaintLead.maxPrepaintDeficitPx).toBe(0);
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
  const issueTimelineDisclosure = page.getByTestId("issue-timeline-disclosure");
  await expect(issueTimelineDisclosure).toBeVisible({ timeout: 30_000 });
  const initialHiddenCount = Number(
    (await issueTimelineDisclosure.textContent())?.match(/(\d+) hidden/u)?.[1],
  );
  expect(initialHiddenCount).toBeGreaterThan(0);
  await issueTimelineDisclosure.getByRole("button", { name: "Load more" }).click();
  const nextHiddenCount = Number(
    (await issueTimelineDisclosure.textContent())?.match(/(\d+) hidden/u)?.[1],
  );
  expect(nextHiddenCount).toBeGreaterThan(0);
  expect(nextHiddenCount).toBeLessThan(initialHiddenCount);

  await page.keyboard.press("Control+f");
  const issueFind = page.getByRole("search", { name: "Find in issue" });
  await expect(issueFind).toBeVisible();
  await issueFind.getByRole("textbox", { name: "Find in issue" })
    .fill("Pressure issue comment 250.");
  await expect(issueFind).toContainText(/1 of [1-9]\d*/u);
  await expect(page.getByText("Pressure issue comment 250.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("comment-thread-virtual-timeline")).toHaveCount(0);
  await issueFind.getByRole("button", { name: "Close find" }).click();

  const issueVirtualTimeline = page.getByTestId("comment-thread-virtual-timeline");
  await expect(issueVirtualTimeline).toBeVisible({ timeout: 30_000 });
  expect(await page.locator("[data-run-id]").count()).toBeLessThan(30);
  expect(await issueVirtualTimeline.locator("[data-virtualized-activity-key]").count()).toBeLessThan(30);
  const issueActivityScrollCoverage = await measureIssueActivityScrollCoverage(page);
  console.log(`THREAD_PRESSURE_ISSUE_SCROLL_COVERAGE ${JSON.stringify(issueActivityScrollCoverage)}`);
  expect(issueActivityScrollCoverage.sampleCount).toBeGreaterThan(0);
  expect(issueActivityScrollCoverage.blankSamples).toEqual([]);
  expect(issueActivityScrollCoverage.maxMountedRowCount).toBeLessThan(40);

  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
  const mobileComposer = page.getByLabel("Comment composer");
  const mobileComposerEditorScroll = page.getByTestId("issue-comment-composer-editor-scroll");
  const mobileComposerEditor = mobileComposer.locator('[contenteditable="true"]');
  await expect(mobileComposerEditor).toBeVisible();
  const compactComposerGeometry = await mobileComposer.evaluate((element) => {
    const editorScroll = element.querySelector<HTMLElement>(
      "[data-testid='issue-comment-composer-editor-scroll']",
    );
    if (!editorScroll) throw new Error("Mobile comment editor scroll surface is missing");
    return {
      composerHeight: element.getBoundingClientRect().height,
      editorHeight: editorScroll.getBoundingClientRect().height,
    };
  });
  expect(compactComposerGeometry.composerHeight).toBeLessThanOrEqual(60);
  expect(compactComposerGeometry.editorHeight).toBeLessThanOrEqual(30);

  await mobileComposerEditor.fill(
    Array.from({ length: 12 }, (_, index) => `Composer growth line ${index + 1}`).join("\n"),
  );
  await expect(mobileComposer).toHaveAttribute("data-composer-state", "composing");
  await expect.poll(
    () => mobileComposerEditorScroll.evaluate((element) => element.clientHeight),
  ).toBeGreaterThan(compactComposerGeometry.editorHeight);
  const expandedComposerGeometry = await mobileComposer.evaluate((element) => {
    const editorScroll = element.querySelector<HTMLElement>(
      "[data-testid='issue-comment-composer-editor-scroll']",
    );
    if (!editorScroll) throw new Error("Mobile comment editor scroll surface is missing");
    return {
      composerHeight: element.getBoundingClientRect().height,
      editorClientHeight: editorScroll.clientHeight,
      editorOverflowY: getComputedStyle(editorScroll).overflowY,
      editorScrollHeight: editorScroll.scrollHeight,
    };
  });
  expect(expandedComposerGeometry.composerHeight).toBeLessThanOrEqual(178);
  expect(expandedComposerGeometry.editorClientHeight).toBeLessThanOrEqual(160);
  expect(expandedComposerGeometry.editorScrollHeight).toBeGreaterThan(expandedComposerGeometry.editorClientHeight);
  expect(expandedComposerGeometry.editorOverflowY).toBe("auto");
  await expect(mobileComposer.getByRole("button", { name: "Comment" })).toBeVisible();
  await page.screenshot({ path: "/tmp/rudder-thread-pressure-issue-composer-expanded.png" });

  await mobileComposerEditor.press("Meta+A");
  await mobileComposerEditor.press("Backspace");
  await mobileComposerEditor.press(" ");
  await mobileComposerEditor.press("Backspace");
  await expect(mobileComposer).toHaveAttribute("data-composer-state", "empty");
  await expect.poll(
    () => mobileComposer.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(60);
  const constrainedScrollRootState = await issueVirtualTimeline.evaluate((timeline) => {
    const issueRoot = document.querySelector<HTMLElement>("[data-testid='issue-detail-main-scroll']");
    const main = document.querySelector<HTMLElement>("#main-content");
    return {
      issueClientHeight: issueRoot?.clientHeight ?? null,
      issueOverflowY: issueRoot ? getComputedStyle(issueRoot).overflowY : null,
      mainClientHeight: main?.clientHeight ?? null,
      mainOverflowY: main ? getComputedStyle(main).overflowY : null,
      mode: timeline.getAttribute("data-virtualized-scroll-root"),
      mountedRows: timeline.querySelectorAll("[data-virtualized-activity-key]").length,
      windowHeight: window.innerHeight,
    };
  });
  console.log(`THREAD_PRESSURE_ISSUE_CONSTRAINED_ROOT ${JSON.stringify(constrainedScrollRootState)}`);
  expect(constrainedScrollRootState).toMatchObject({
    mainOverflowY: "visible",
    mode: "window",
  });
  await expect.poll(
    () => issueVirtualTimeline.locator("[data-virtualized-activity-key]").count(),
  ).toBeLessThan(40);
  const constrainedIssueActivityScrollCoverage = await measureIssueActivityScrollCoverage(
    page,
    "document",
  );
  console.log(
    `THREAD_PRESSURE_ISSUE_CONSTRAINED_SCROLL_COVERAGE ${JSON.stringify(constrainedIssueActivityScrollCoverage)}`,
  );
  expect(constrainedIssueActivityScrollCoverage.sampleCount).toBeGreaterThan(0);
  expect(constrainedIssueActivityScrollCoverage.blankSamples).toEqual([]);
  expect(constrainedIssueActivityScrollCoverage.composerHiddenSamples).toEqual([]);
  expect(constrainedIssueActivityScrollCoverage.maxMountedRowCount).toBeLessThan(40);
  await page.screenshot({ path: "/tmp/rudder-thread-pressure-issue-constrained.png" });
  await page.evaluate(() => window.scrollTo(0, 0));
  if (desktopViewport) {
    await page.setViewportSize(desktopViewport);
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeHidden();
    await expect(issueVirtualTimeline).toHaveAttribute("data-virtualized-scroll-root", "element");
  }

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
      prepaintLead: messengerPrepaintLead,
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

test("progressively reveals a production-shaped Issue activity timeline", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Issue-Disclosure-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };

  const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Timeline Evidence Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { command: "codex", model: "gpt-5.4" },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json() as { id: string };

  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Adaptive Issue activity disclosure",
      description: "A mixed-height timeline with comments and run evidence.",
      status: "todo",
      priority: "high",
    },
  });
  expect(issueResponse.ok()).toBe(true);
  const issue = await issueResponse.json() as { id: string; identifier: string | null };

  const anchor = Date.parse("2026-07-20T00:00:00.000Z");
  const commentIds: string[] = [];
  await insertGeneratedChunks(
    120,
    (index) => {
      const id = randomUUID();
      const createdAt = new Date(anchor + index * 2_000);
      commentIds.push(id);
      return {
        id,
        orgId: organization.id,
        issueId: issue.id,
        authorAgentId: index % 4 === 0 ? null : agent.id,
        authorUserId: index % 4 === 0 ? "local-board" : null,
        body: index % 9 === 0
          ? `Disclosure comment ${index + 1}.\n\n${"Large agent evidence block. ".repeat(90)}`
          : `Disclosure comment ${index + 1}. ${"evidence ".repeat(index % 5)}`,
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => e2eDb.insert(issueComments).values(rows),
  );
  await insertGeneratedChunks(
    40,
    (index) => {
      const createdAt = new Date(anchor + index * 2_000 + 1_000);
      return {
        id: randomUUID(),
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "issue_assignment",
        triggerDetail: `disclosure run ${index + 1}`,
        status: "succeeded",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 30_000),
        stdoutExcerpt: `Disclosure run ${index + 1} summary output.`,
        resultSummaryJson: { summary: `Disclosure result ${index + 1}` },
        contextSnapshot: { issueId: issue.id, taskId: issue.id },
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => e2eDb.insert(heartbeatRuns).values(rows),
  );

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const disclosure = page.getByTestId("issue-timeline-disclosure");
  await expect(disclosure).toBeVisible({ timeout: 30_000 });
  await expect(disclosure.getByRole("button", { name: "Load more" })).toBeVisible();
  const initialLabel = await disclosure.textContent();
  const initialHiddenCount = Number(initialLabel?.match(/(\d+) hidden/u)?.[1]);
  expect(initialHiddenCount).toBeGreaterThan(0);
  await page.screenshot({ path: "/tmp/rudder-issue-activity-disclosure-desktop.png" });

  await disclosure.getByRole("button", { name: "Load more" }).click();
  await expect.poll(async () => {
    const label = await disclosure.textContent();
    return Number(label?.match(/(\d+) hidden/u)?.[1]);
  }).toBeLessThan(initialHiddenCount);
  const nextHiddenCount = Number((await disclosure.textContent())?.match(/(\d+) hidden/u)?.[1]);
  expect(initialHiddenCount - nextHiddenCount).toBeGreaterThanOrEqual(8);
  const issueScrollRoot = page.getByTestId("issue-detail-main-scroll");
  await issueScrollRoot.evaluate((element) => {
    const scrollRoot = element as HTMLElement;
    scrollRoot.scrollTop = 0;
    scrollRoot.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByText("Disclosure comment 2.", { exact: false })).toBeVisible();
  await issueScrollRoot.evaluate((element) => {
    const scrollRoot = element as HTMLElement;
    scrollRoot.scrollTop = scrollRoot.scrollHeight;
    scrollRoot.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByText("Disclosure comment 119.", { exact: false })).toBeVisible();

  const hiddenTargetId = commentIds[80]!;
  await expect(page.locator(`#comment-${hiddenTargetId}`)).toHaveCount(0);
  await page.evaluate((commentId) => {
    window.location.hash = `comment-${commentId}`;
  }, hiddenTargetId);
  await expect(page.locator(`#comment-${hiddenTargetId}`)).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("Control+f");
  const issueFind = page.getByRole("search", { name: "Find in issue" });
  await expect(issueFind).toBeVisible();
  await issueFind.getByRole("textbox", { name: "Find in issue" })
    .fill("Disclosure comment 61.");
  await expect(issueFind).toContainText(/1 of [1-9]\d*/u);
  await expect(page.getByText("Disclosure comment 61.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("comment-thread-virtual-timeline")).toHaveCount(0);
  await issueFind.getByRole("button", { name: "Close find" }).click();
  await expect(page.getByTestId("comment-thread-virtual-timeline")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Activity", exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/rudder-issue-activity-disclosure-mobile.png" });
});

test("keeps the mobile issue comment composer compact, growing, and bounded", async ({ page }) => {
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Mobile-Composer-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };

  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Mobile comment composer interaction fixture",
      description: "A focused browser fixture for the Issue Activity composer.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueResponse.ok()).toBe(true);
  const issue = await issueResponse.json() as { id: string; identifier: string | null };
  const pressureCommentResponses = await Promise.all(
    Array.from({ length: 18 }, (_, index) => page.request.post(`/api/issues/${issue.id}/comments`, {
      data: {
        body: `Mobile composer pressure comment ${index + 1}. This keeps Activity tall enough to expose the scroll-to-bottom control.`,
      },
    })),
  );
  expect(pressureCommentResponses.every((response) => response.ok())).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  const composer = page.getByLabel("Comment composer");
  const editorScroll = page.getByTestId("issue-comment-composer-editor-scroll");
  const editor = composer.locator('[contenteditable="true"]');
  await expect(editor).toBeVisible();
  const placeholder = composer.getByText("Leave a comment...", { exact: true });
  await expect(placeholder).toBeVisible();

  const readTextRange = async (locator: ReturnType<typeof composer.locator>) => locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    if (!textNode) throw new Error("Expected editable text node");
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const placeholderTextRange = await placeholder.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const commentButtonTextRange = await composer.getByRole("button", { name: "Comment" }).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await editor.fill("Composer alignment probe");
  const editorTextRange = await readTextRange(editor);
  expect(Math.abs(placeholderTextRange.x - editorTextRange.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(placeholderTextRange.y - editorTextRange.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(placeholderTextRange.height - editorTextRange.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(commentButtonTextRange.y - editorTextRange.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(commentButtonTextRange.height - editorTextRange.height)).toBeLessThanOrEqual(1);
  await editor.fill("");
  await expect(placeholder).toBeVisible();

  const compactGeometry = await composer.evaluate((element) => {
    const scroll = element.querySelector<HTMLElement>(
      "[data-testid='issue-comment-composer-editor-scroll']",
    );
    if (!scroll) throw new Error("Mobile comment editor scroll surface is missing");
    const outer = element.closest<HTMLElement>("[data-testid='comment-thread-fixed-composer']");
    if (!outer) throw new Error("Mobile comment composer outer surface is missing");
    const activity = element.closest<HTMLElement>("section[aria-label='Activity']");
    if (!activity) throw new Error("Issue Activity section is missing");
    const activityRect = activity.getBoundingClientRect();
    const composerRect = element.getBoundingClientRect();
    return {
      activityLeft: activityRect.left,
      activityRight: activityRect.right,
      composerHeight: composerRect.height,
      composerLeft: composerRect.left,
      composerRight: composerRect.right,
      editorHeight: scroll.getBoundingClientRect().height,
      composerBackground: getComputedStyle(element).backgroundColor,
      outerBackground: getComputedStyle(outer).backgroundColor,
    };
  });
  expect(compactGeometry.composerHeight).toBeLessThanOrEqual(60);
  expect(compactGeometry.editorHeight).toBeLessThanOrEqual(30);
  expect(Math.abs(compactGeometry.composerLeft - compactGeometry.activityLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(compactGeometry.composerRight - compactGeometry.activityRight)).toBeLessThanOrEqual(1);
  expect(compactGeometry.outerBackground).toBe("rgba(0, 0, 0, 0)");
  expect(compactGeometry.composerBackground).not.toBe("rgba(0, 0, 0, 0)");
  await page.evaluate(() => window.scrollTo(0, 1));
  const scrollToBottom = page.getByRole("button", { name: "Scroll to bottom" });
  await expect(scrollToBottom).toBeVisible();
  const commentButton = composer.getByRole("button", { name: "Comment" });
  const controlsOverlap = async () => {
    const [scrollRect, commentRect] = await Promise.all([
      scrollToBottom.boundingBox(),
      commentButton.boundingBox(),
    ]);
    if (!scrollRect || !commentRect) throw new Error("Composer controls are missing geometry");
    return !(
      scrollRect.x + scrollRect.width <= commentRect.x
      || commentRect.x + commentRect.width <= scrollRect.x
      || scrollRect.y + scrollRect.height <= commentRect.y
      || commentRect.y + commentRect.height <= scrollRect.y
    );
  };
  await expect.poll(controlsOverlap).toBe(false);
  await page.screenshot({ path: "/tmp/rudder-mobile-comment-composer-empty.png" });

  await editor.fill(
    Array.from({ length: 12 }, (_, index) => `Composer growth line ${index + 1}`).join("\n"),
  );
  await expect(composer).toHaveAttribute("data-composer-state", "composing");
  await expect(composer.getByText("Leave a comment...", { exact: true })).toHaveCount(0);
  await expect.poll(() => editorScroll.evaluate((element) => element.clientHeight))
    .toBeGreaterThan(compactGeometry.editorHeight);
  const expandedGeometry = await composer.evaluate((element) => {
    const scroll = element.querySelector<HTMLElement>(
      "[data-testid='issue-comment-composer-editor-scroll']",
    );
    if (!scroll) throw new Error("Mobile comment editor scroll surface is missing");
    const outer = element.closest<HTMLElement>("[data-testid='comment-thread-fixed-composer']");
    if (!outer) throw new Error("Mobile comment composer outer surface is missing");
    const activity = element.closest<HTMLElement>("section[aria-label='Activity']");
    if (!activity) throw new Error("Issue Activity section is missing");
    const activityRect = activity.getBoundingClientRect();
    const composerRect = element.getBoundingClientRect();
    return {
      activityLeft: activityRect.left,
      activityRight: activityRect.right,
      composerHeight: composerRect.height,
      composerLeft: composerRect.left,
      composerRight: composerRect.right,
      editorClientHeight: scroll.clientHeight,
      editorScrollHeight: scroll.scrollHeight,
      editorOverflowY: getComputedStyle(scroll).overflowY,
      composerBackground: getComputedStyle(element).backgroundColor,
      outerBackground: getComputedStyle(outer).backgroundColor,
    };
  });
  expect(expandedGeometry.composerHeight).toBeLessThanOrEqual(178);
  expect(expandedGeometry.editorClientHeight).toBeLessThanOrEqual(160);
  expect(expandedGeometry.editorScrollHeight).toBeGreaterThan(expandedGeometry.editorClientHeight);
  expect(expandedGeometry.editorOverflowY).toBe("auto");
  expect(Math.abs(expandedGeometry.composerLeft - expandedGeometry.activityLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(expandedGeometry.composerRight - expandedGeometry.activityRight)).toBeLessThanOrEqual(1);
  expect(expandedGeometry.outerBackground).toBe("rgba(0, 0, 0, 0)");
  expect(expandedGeometry.composerBackground).not.toBe("rgba(0, 0, 0, 0)");
  await expect(commentButton).toBeVisible();
  await expect.poll(controlsOverlap).toBe(false);
  await page.screenshot({ path: "/tmp/rudder-mobile-comment-composer-expanded.png" });

  await editor.press("Meta+A");
  await editor.press("Backspace");
  await editor.press(" ");
  await editor.press("Backspace");
  await expect(composer).toHaveAttribute("data-composer-state", "empty");
  await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThanOrEqual(60);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(editorScroll).toHaveCSS("height", "64px");
  await expect(scrollToBottom).toBeVisible();
  expect(await scrollToBottom.evaluate((element) => ({
    computedBottom: getComputedStyle(element).bottom,
    inlineBottom: element.style.bottom,
  }))).toEqual({ computedBottom: "24px", inlineBottom: "" });
  await scrollToBottom.click();
  const issueScrollRoot = page.getByTestId("issue-detail-main-scroll");
  await expect.poll(() => issueScrollRoot.evaluate((element) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ))).toBeLessThanOrEqual(1);
});

test("preserves issue description images across background refresh and scrolling", async ({ page }) => {
  test.setTimeout(180_000);
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Issue-Image-Stability-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };
  const description = [
    "## Image stability fixture",
    "![Evidence](/android-chrome-512x512.png)",
    ...Array.from(
      { length: 80 },
      (_, paragraphIndex) => `Description paragraph ${paragraphIndex + 1}.`,
    ),
  ].join("\n\n");
  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue description image stability fixture",
      description,
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueResponse.ok()).toBe(true);
  const issue = await issueResponse.json() as { id: string; identifier?: string | null };
  const issuePath = `/api/issues/${issue.identifier ?? issue.id}`;
  let issueRefreshCount = 0;
  page.on("response", (response) => {
    if (response.request().method() === "GET" && new URL(response.url()).pathname === issuePath) {
      issueRefreshCount += 1;
    }
  });

  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  const images = page.locator(".rudder-markdown img");
  await expect(images).toHaveCount(1, { timeout: 90_000 });
  const refreshCountAfterLoad = issueRefreshCount;
  await images.first().evaluate(() => {
    const stabilityWindow = window as typeof window & { __issueDescriptionImages?: Element[] };
    stabilityWindow.__issueDescriptionImages = Array.from(
      document.querySelectorAll(".rudder-markdown img"),
    );
  });

  await expect.poll(() => issueRefreshCount, { timeout: 10_000 }).toBeGreaterThan(refreshCountAfterLoad);
  const imageStability = () => images.first().evaluate(() => {
    const stabilityWindow = window as typeof window & { __issueDescriptionImages?: Element[] };
    const initialImages = stabilityWindow.__issueDescriptionImages ?? [];
    const currentImages = Array.from(document.querySelectorAll(".rudder-markdown img"));
    return {
      connected: initialImages.filter((image) => image.isConnected).length,
      current: currentImages.length,
      same: currentImages.filter((image, index) => image === initialImages[index]).length,
    };
  });
  expect(await imageStability()).toEqual({ connected: 1, current: 1, same: 1 });

  const issueScrollRoot = page.getByTestId("issue-detail-main-scroll");
  await issueScrollRoot.evaluate((element) => {
    element.scrollTop = Math.min(200, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(100);
  await issueScrollRoot.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });

  expect(await imageStability()).toEqual({ connected: 1, current: 1, same: 1 });
});

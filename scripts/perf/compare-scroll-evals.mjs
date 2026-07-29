import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function usage() {
  console.error("Usage: node scripts/perf/compare-scroll-evals.mjs <before.json> <after.json> [report.md]");
}

function numberAt(value, pathParts) {
  let current = value;
  for (const part of pathParts) current = current?.[part];
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function delta(before, after) {
  if (before === null || after === null) return null;
  return {
    before,
    after,
    absolute: after - before,
    percent: before === 0 ? null : ((after - before) / before) * 100,
  };
}

function formatNumber(value, digits = 1) {
  return value === null ? "n/a" : value.toFixed(digits);
}

function formatDelta(metric) {
  if (!metric) return "n/a";
  const percent = metric.percent === null ? "n/a" : `${metric.percent >= 0 ? "+" : ""}${metric.percent.toFixed(1)}%`;
  return `${formatNumber(metric.before)} → ${formatNumber(metric.after)} (${percent})`;
}

function formatRatioDelta(metric) {
  if (!metric) return "n/a";
  const before = `${(metric.before * 100).toFixed(1)}%`;
  const after = `${(metric.after * 100).toFixed(1)}%`;
  const change = metric.before === 0
    ? "n/a"
    : `${metric.percent >= 0 ? "+" : ""}${metric.percent.toFixed(1)}%`;
  return `${before} → ${after} (${change})`;
}

async function main() {
  const [beforePath, afterPath, reportPathArg] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    usage();
    process.exitCode = 2;
    return;
  }

  const [before, after] = await Promise.all([
    readFile(path.resolve(beforePath), "utf8").then(JSON.parse),
    readFile(path.resolve(afterPath), "utf8").then(JSON.parse),
  ]);
  const metrics = {
    chatDomMessages: delta(
      numberAt(before, ["chat", "domMessages"]),
      numberAt(after, ["chat", "domMessages"]),
    ),
    chatP95FrameMs: delta(
      numberAt(before, ["chat", "scroll", "p95FrameIntervalMs"]),
      numberAt(after, ["chat", "scroll", "p95FrameIntervalMs"]),
    ),
    chatDroppedFrameRatio: delta(
      numberAt(before, ["chat", "scroll", "droppedFrameRatio"]),
      numberAt(after, ["chat", "scroll", "droppedFrameRatio"]),
    ),
    chatLongTasks: delta(
      numberAt(before, ["chat", "scroll", "longTaskCount"]),
      numberAt(after, ["chat", "scroll", "longTaskCount"]),
    ),
    chatRendererTaskMs: delta(
      numberAt(before, ["chat", "scroll", "rendererTaskDurationMs"]),
      numberAt(after, ["chat", "scroll", "rendererTaskDurationMs"]),
    ),
    messengerMountedRows: delta(
      numberAt(before, ["messenger", "mountedRows"]),
      numberAt(after, ["messenger", "mountedRows"]),
    ),
    messengerP95FrameMs: delta(
      numberAt(before, ["messenger", "scroll", "p95FrameIntervalMs"]),
      numberAt(after, ["messenger", "scroll", "p95FrameIntervalMs"]),
    ),
    messengerDroppedFrameRatio: delta(
      numberAt(before, ["messenger", "scroll", "droppedFrameRatio"]),
      numberAt(after, ["messenger", "scroll", "droppedFrameRatio"]),
    ),
    messengerRendererTaskMs: delta(
      numberAt(before, ["messenger", "scroll", "rendererTaskDurationMs"]),
      numberAt(after, ["messenger", "scroll", "rendererTaskDurationMs"]),
    ),
    chatReadyMs: delta(
      numberAt(before, ["chat", "readyMs"]),
      numberAt(after, ["chat", "readyMs"]),
    ),
    rendererJsHeapMb: delta(
      numberAt(before, ["runtime", "jsHeapUsedMb"]),
      numberAt(after, ["runtime", "jsHeapUsedMb"]),
    ),
    rendererDomNodes: delta(
      numberAt(before, ["runtime", "domNodes"]),
      numberAt(after, ["runtime", "domNodes"]),
    ),
    rendererEventListeners: delta(
      numberAt(before, ["runtime", "jsEventListeners"]),
      numberAt(after, ["runtime", "jsEventListeners"]),
    ),
  };

  const checks = {
    boundedChatDom: (metrics.chatDomMessages?.after ?? Number.POSITIVE_INFINITY) < 60,
    boundedMessengerDom: (metrics.messengerMountedRows?.after ?? Number.POSITIVE_INFINITY) < 60,
    chatDroppedFramesImproved: (metrics.chatDroppedFrameRatio?.absolute ?? 1) <= 0,
    messengerDroppedFramesImproved: (metrics.messengerDroppedFrameRatio?.absolute ?? 1) <= 0,
    noChatLongTaskRegression: (metrics.chatLongTasks?.absolute ?? 1) <= 0,
    chatRendererTaskTimeImproved: (metrics.chatRendererTaskMs?.absolute ?? 1) <= 0,
    messengerRendererTaskTimeImproved: (metrics.messengerRendererTaskMs?.absolute ?? 1) <= 0,
    productionChatFrameBudget: (metrics.chatP95FrameMs?.after ?? Number.POSITIVE_INFINITY) < 16.7,
    productionMessengerFrameBudget: (metrics.messengerP95FrameMs?.after ?? Number.POSITIVE_INFINITY) < 16.7,
    productionChatDroppedFrames: (metrics.chatDroppedFrameRatio?.after ?? Number.POSITIVE_INFINITY) < 0.05,
    productionMessengerDroppedFrames: (metrics.messengerDroppedFrameRatio?.after ?? Number.POSITIVE_INFINITY) < 0.05,
  };
  const passed = Object.values(checks).every(Boolean);
  const report = [
    "# Rudder scroll performance eval",
    "",
    `Verdict: ${passed ? "PASS" : "FAIL"}`,
    "",
    "| Metric | Before → After |",
    "| --- | ---: |",
    `| Chat mounted message nodes | ${formatDelta(metrics.chatDomMessages)} |`,
    `| Chat ready time (ms) | ${formatDelta(metrics.chatReadyMs)} |`,
    `| Chat p95 frame interval (ms) | ${formatDelta(metrics.chatP95FrameMs)} |`,
    `| Chat dropped-frame ratio | ${formatRatioDelta(metrics.chatDroppedFrameRatio)} |`,
    `| Chat long tasks | ${formatDelta(metrics.chatLongTasks)} |`,
    `| Chat renderer task time (ms) | ${formatDelta(metrics.chatRendererTaskMs)} |`,
    `| Messenger mounted rows | ${formatDelta(metrics.messengerMountedRows)} |`,
    `| Messenger p95 frame interval (ms) | ${formatDelta(metrics.messengerP95FrameMs)} |`,
    `| Messenger dropped-frame ratio | ${formatRatioDelta(metrics.messengerDroppedFrameRatio)} |`,
    `| Messenger renderer task time (ms) | ${formatDelta(metrics.messengerRendererTaskMs)} |`,
    `| DOM nodes | ${formatDelta(metrics.rendererDomNodes)} |`,
    `| JS event listeners | ${formatDelta(metrics.rendererEventListeners)} |`,
    `| Renderer JS heap (MiB) | ${formatDelta(metrics.rendererJsHeapMb)} |`,
    "",
    "## Checks",
    "",
    ...Object.entries(checks).map(([name, ok]) => `- ${ok ? "PASS" : "FAIL"}: ${name}`),
    "",
  ].join("\n");

  const reportPath = path.resolve(reportPathArg ?? "scroll-performance-eval.md");
  await writeFile(reportPath, report, "utf8");
  console.log(JSON.stringify({ passed, metrics, checks, reportPath }, null, 2));
  if (!passed) process.exitCode = 1;
}

await main();

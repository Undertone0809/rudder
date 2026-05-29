// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@rudderhq/shared";
import {
  applyRunFilters,
  applyRunSort,
  parseRunFilterState,
  RunFiltersToolbar,
  type RunFilterState,
  runFilterChips,
  runSkillOptions,
  writeRunFilterState,
} from "./AgentDetail.run-filters";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
    startedAt: null,
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    createdAt: new Date("2026-05-24T12:00:00.000Z"),
    updatedAt: new Date("2026-05-24T12:00:00.000Z"),
    ...overrides,
  };
}

function defaultFilterState(overrides: Partial<RunFilterState> = {}): RunFilterState {
  return {
    view: "all",
    q: "",
    statuses: [],
    sources: [],
    contexts: [],
    skills: [],
    date: "all",
    cost: [],
    sort: "newest",
    ...overrides,
  };
}

function renderToolbar({
  state = defaultFilterState(),
  onChange = () => undefined,
}: {
  state?: RunFilterState;
  onChange?: (patch: Partial<RunFilterState>) => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(RunFiltersToolbar, {
      runs: [],
      filteredCount: 0,
      state,
      onChange,
      onClear: () => undefined,
    }));
  });
  return { container, root };
}

function cleanupToolbar(root: Root, container: HTMLElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.replaceChildren();
}

describe("agent run filters", () => {
  it("parses and writes URL query state without dropping unrelated params", () => {
    const original = new URLSearchParams("tab=runs&runView=failed&runStatus=failed,timed_out&runContext=retry&runSkill=build-advisor&runQ=process&runSort=duration_desc");
    const state = parseRunFilterState(original);

    expect(state.view).toBe("failed");
    expect(state.statuses).toEqual(["failed", "timed_out"]);
    expect(state.contexts).toEqual(["retry"]);
    expect(state.skills).toEqual(["build-advisor"]);
    expect(state.q).toBe("process");
    expect(state.sort).toBe("duration_desc");

    const next = writeRunFilterState(original, {
      view: "all",
      q: "",
      statuses: [],
      contexts: [],
      skills: [],
      sort: "newest",
    });

    expect(next.get("tab")).toBe("runs");
    expect(next.get("runView")).toBeNull();
    expect(next.get("runStatus")).toBeNull();
    expect(next.get("runContext")).toBeNull();
    expect(next.get("runSkill")).toBeNull();
    expect(next.get("runQ")).toBeNull();
    expect(next.get("runSort")).toBeNull();
  });

  it("filters by status, issue context, retry context, used skill, token cost, and search text", () => {
    const normal = run({
      id: "11111111-0000-4000-8000-000000000000",
      resultJson: { summary: "Finished ordinary run" },
    });
    const issueRetry = run({
      id: "22222222-0000-4000-8000-000000000000",
      status: "failed",
      errorCode: "process_lost",
      retryOfRunId: "11111111-0000-4000-8000-000000000000",
      contextSnapshot: {
        issueId: "issue-1",
        recovery: {
          originalRunId: "11111111-0000-4000-8000-000000000000",
          failureKind: "process_lost",
          failureSummary: "Process lost on launch",
          recoveryTrigger: "automatic",
          recoveryMode: "continue_preferred",
        },
      },
      usageJson: {
        inputTokens: 600_000,
        cachedInputTokens: 100_000,
        outputTokens: 25_000,
      },
      resultJson: { summary: "Process lost on launch" },
    });
    const skillRun = run({
      id: "33333333-0000-4000-8000-000000000000",
      status: "failed",
      errorCode: "process_lost",
      contextSnapshot: {
        issueId: "issue-2",
        recovery: {
          originalRunId: "11111111-0000-4000-8000-000000000000",
          failureKind: "process_lost",
          failureSummary: "Process lost on launch",
          recoveryTrigger: "automatic",
          recoveryMode: "continue_preferred",
        },
      },
      usageJson: {
        inputTokens: 600_000,
        cachedInputTokens: 100_000,
        outputTokens: 25_000,
      },
      resultJson: {
        summary: "Process lost on launch",
        skillEvidenceType: "used",
        usedSkills: [{ key: "build-advisor", runtimeName: "build-advisor", name: "Build Advisor" }],
      },
    });

    const filtered = applyRunFilters([normal, issueRetry, skillRun], {
      view: "all",
      q: "launch",
      statuses: ["failed"],
      sources: [],
      contexts: ["issue", "retry", "process_lost"],
      skills: ["build-advisor"],
      date: "all",
      cost: ["high_tokens"],
      sort: "newest",
    });

    expect(filtered.map((item) => item.id)).toEqual([skillRun.id]);
  });

  it("lists used skill filter options with run counts", () => {
    const first = run({
      id: "11111111-0000-4000-8000-000000000000",
      resultJson: {
        skillEvidenceType: "used",
        usedSkills: [{ key: "build-advisor", runtimeName: "build-advisor", name: "Build Advisor" }],
      },
    });
    const second = run({
      id: "22222222-0000-4000-8000-000000000000",
      resultJson: {
        skillEvidenceType: "used",
        usedSkillKeys: ["build-advisor", "debug-run-transcript"],
      },
    });

    expect(runSkillOptions([first, second])).toEqual([
      { key: "build-advisor", label: "build-advisor", count: 2 },
      { key: "debug-run-transcript", label: "debug-run-transcript", count: 1 },
    ]);
  });

  it("describes active filter chips for the floating toolbar", () => {
    const chips = runFilterChips({
      view: "issue",
      q: "ZST-289",
      statuses: ["succeeded"],
      sources: ["assignment"],
      contexts: ["followup"],
      skills: ["build-advisor", "debug-run-transcript"],
      date: "7d",
      cost: ["long"],
      sort: "duration_desc",
    });

    expect(chips).toEqual([
      "Issue work",
      "Search: ZST-289",
      "Status: Succeeded",
      "Source: Assignment",
      "Passive follow-up",
      "Skill: build-advisor, debug-run-transcript",
      ">30m",
      "7d",
    ]);
  });

  it("sorts filtered runs by duration after filtering", () => {
    const shortRun = run({
      id: "11111111-0000-4000-8000-000000000000",
      startedAt: new Date("2026-05-24T12:00:00.000Z"),
      finishedAt: new Date("2026-05-24T12:03:00.000Z"),
      createdAt: new Date("2026-05-24T12:00:00.000Z"),
    });
    const longRun = run({
      id: "22222222-0000-4000-8000-000000000000",
      startedAt: new Date("2026-05-24T11:00:00.000Z"),
      finishedAt: new Date("2026-05-24T12:00:00.000Z"),
      createdAt: new Date("2026-05-24T11:00:00.000Z"),
    });
    const mediumRun = run({
      id: "33333333-0000-4000-8000-000000000000",
      startedAt: new Date("2026-05-24T10:00:00.000Z"),
      finishedAt: new Date("2026-05-24T10:20:00.000Z"),
      createdAt: new Date("2026-05-24T10:00:00.000Z"),
    });

    expect(applyRunSort([shortRun, longRun, mediumRun], "duration_desc").map((item) => item.id)).toEqual([
      longRun.id,
      mediumRun.id,
      shortRun.id,
    ]);
  });

  it("sorts runs by ascending token and cost totals", () => {
    const cheap = run({
      id: "11111111-0000-4000-8000-000000000000",
      usageJson: { inputTokens: 10, outputTokens: 5, costCents: 1 },
      createdAt: new Date("2026-05-24T12:00:00.000Z"),
    });
    const expensive = run({
      id: "22222222-0000-4000-8000-000000000000",
      usageJson: { inputTokens: 100, outputTokens: 50, costCents: 20 },
      createdAt: new Date("2026-05-24T11:00:00.000Z"),
    });

    expect(applyRunSort([expensive, cheap], "tokens_asc").map((item) => item.id)).toEqual([
      cheap.id,
      expensive.id,
    ]);
    expect(applyRunSort([expensive, cheap], "cost_asc").map((item) => item.id)).toEqual([
      cheap.id,
      expensive.id,
    ]);
  });

  it("uses the issue-board sort interaction for run sorting", () => {
    const patches: Array<Partial<RunFilterState>> = [];
    const { container, root } = renderToolbar({
      onChange: (patch) => patches.push(patch),
    });

    try {
      const sortButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Sort"),
      );
      expect(sortButton?.textContent).toContain("Sort");
      expect(sortButton?.textContent).not.toContain("Newest");

      act(() => {
        sortButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      const createdButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Created"),
      );
      const durationButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Duration"),
      );
      expect(createdButton?.textContent).toContain("\u2193");

      act(() => {
        createdButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(patches.at(-1)).toMatchObject({ sort: "oldest" });

      act(() => {
        durationButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(patches.at(-1)).toMatchObject({ sort: "duration_asc" });
    } finally {
      cleanupToolbar(root, container);
    }
  });
});

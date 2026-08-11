import { describe, expect, it } from "vitest";
import {
  createInitialIssueTimelineDisclosure,
  estimateIssueTimelineItemHeight,
  issueTimelineBatchBudget,
  revealIssueTimelineTarget,
  revealNextIssueTimelineBatch,
  selectIssueTimelineDisclosureItems,
  type IssueTimelineDisclosureItem,
} from "./issue-timeline-disclosure";

function activityItems(count: number): IssueTimelineDisclosureItem[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `activity:${String(index).padStart(3, "0")}`,
    kind: "activity",
    createdAtMs: index,
  }));
}

describe("issue timeline disclosure", () => {
  it("uses the bounded viewport-relative batch budget", () => {
    expect(issueTimelineBatchBudget(400)).toBe(640);
    expect(issueTimelineBatchBudget(1_000)).toBe(800);
    expect(issueTimelineBatchBudget(2_000)).toBe(900);
  });

  it("estimates compact rows, active runs, and large comments differently", () => {
    expect(estimateIssueTimelineItemHeight({
      key: "activity:1",
      kind: "activity",
      createdAtMs: 1,
    }, 600)).toBe(40);
    expect(estimateIssueTimelineItemHeight({
      key: "run:1",
      kind: "run",
      createdAtMs: 1,
      runStatus: "running",
    }, 600)).toBe(320);
    expect(estimateIssueTimelineItemHeight({
      key: "comment:1",
      kind: "comment",
      createdAtMs: 1,
      commentBody: `${"long ".repeat(400)}\n![proof](proof.png)`,
    }, 360)).toBe(720);
  });

  it("keeps earliest and latest context around one hidden middle range", () => {
    const items = activityItems(80);
    const state = createInitialIssueTimelineDisclosure(items, 800, 600);
    const selection = selectIssueTimelineDisclosureItems(items, state);

    expect(state.fullyExpanded).toBe(false);
    expect(selection.visibleHead[0]?.key).toBe("activity:000");
    expect(selection.visibleTail.at(-1)?.key).toBe("activity:079");
    expect(selection.hidden.length).toBeGreaterThanOrEqual(4);
  });

  it("does not create a divider for a tiny or low-height remainder", () => {
    const state = createInitialIssueTimelineDisclosure(activityItems(12), 900, 600);
    expect(state.fullyExpanded).toBe(true);
  });

  it("reveals more compact rows than large comments within one batch", () => {
    const compact = activityItems(100);
    const comments: IssueTimelineDisclosureItem[] = Array.from({ length: 30 }, (_, index) => ({
      key: `comment:${String(index).padStart(3, "0")}`,
      kind: "comment",
      createdAtMs: index,
      commentBody: `${"large agent response ".repeat(160)}![image](proof.png)`,
    }));
    const compactInitial = createInitialIssueTimelineDisclosure(compact, 800, 600);
    const commentInitial = createInitialIssueTimelineDisclosure(comments, 800, 600);
    const compactBefore = selectIssueTimelineDisclosureItems(compact, compactInitial).hidden.length;
    const commentsBefore = selectIssueTimelineDisclosureItems(comments, commentInitial).hidden.length;
    const compactAfter = selectIssueTimelineDisclosureItems(
      compact,
      revealNextIssueTimelineBatch(compact, compactInitial, 800, 600),
    ).hidden.length;
    const commentsAfter = selectIssueTimelineDisclosureItems(
      comments,
      revealNextIssueTimelineBatch(comments, commentInitial, 800, 600),
    ).hidden.length;

    expect(compactBefore - compactAfter).toBeGreaterThan(commentsBefore - commentsAfter);
    expect(compactBefore - compactAfter).toBeLessThanOrEqual(24);
    expect(commentsBefore - commentsAfter).toBeGreaterThanOrEqual(1);
  });

  it("reveals a hidden target through the older-side prefix even beyond a normal batch", () => {
    const items = activityItems(100);
    const initial = createInitialIssueTimelineDisclosure(items, 800, 600);
    const target = selectIssueTimelineDisclosureItems(items, initial).hidden.at(-2)!;
    const next = revealIssueTimelineTarget(items, initial, target.key);
    const selection = selectIssueTimelineDisclosureItems(items, next);

    expect([...selection.visibleHead, ...selection.visibleTail].map((item) => item.key))
      .toContain(target.key);
    expect(selection.hidden.length).toBeLessThan(4);
  });

  it("keeps visible sort boundaries monotonic across inserts and deletes", () => {
    const items = activityItems(80);
    const initial = createInitialIssueTimelineDisclosure(items, 800, 600);
    const before = selectIssueTimelineDisclosureItems(items, initial);
    const changed = [
      { key: "activity:new-old", kind: "activity" as const, createdAtMs: -1 },
      ...items.filter((item) => item.key !== before.visibleHead.at(-1)?.key),
      { key: "activity:new-latest", kind: "activity" as const, createdAtMs: 1_000 },
    ];
    const after = selectIssueTimelineDisclosureItems(changed, initial);

    expect(after.visibleHead[0]?.key).toBe("activity:new-old");
    expect(after.visibleTail.at(-1)?.key).toBe("activity:new-latest");
    expect(after.hidden.length).toBeGreaterThan(0);
  });
});


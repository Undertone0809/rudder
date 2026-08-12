import type { IssueComment } from "@rudderhq/shared";
import type { ReactNode } from "react";
import type { LinkedRunItem } from "./CommentThread.runs";
import type {
  IssueTimelineDisclosureItem,
  IssueTimelineDisclosureSelection,
} from "./issue-timeline-disclosure";

export interface CommentWithRunMeta extends IssueComment {
  runId?: string | null;
  runAgentId?: string | null;
}
export interface CommentThreadActivityItem {
  id: string;
  createdAt: Date | string;
  node: ReactNode;
}

export type CommentThreadTimelineItem =
  | { kind: "comment"; id: string; createdAtMs: number; comment: CommentWithRunMeta }
  | { kind: "run"; id: string; createdAtMs: number; run: LinkedRunItem }
  | { kind: "activity"; id: string; createdAtMs: number; activity: CommentThreadActivityItem };

type TimelineDisclosureDividerItem = {
  kind: "disclosure";
  id: "middle";
  createdAtMs: number;
  hiddenCount: number;
};

export type CommentThreadTimelineRenderItem = CommentThreadTimelineItem | TimelineDisclosureDividerItem;

export function commentThreadTimelineItemKey(item: CommentThreadTimelineRenderItem) {
  return `${item.kind}:${item.id}`;
}

export function buildCommentThreadTimeline({
  activityItems,
  comments,
  linkedRuns,
}: {
  activityItems: CommentThreadActivityItem[];
  comments: CommentWithRunMeta[];
  linkedRuns: LinkedRunItem[];
}) {
  const commentItems: CommentThreadTimelineItem[] = comments.map((comment) => ({
    kind: "comment",
    id: comment.id,
    createdAtMs: new Date(comment.createdAt).getTime(),
    comment,
  }));
  const runItems: CommentThreadTimelineItem[] = linkedRuns.map((run) => ({
    kind: "run",
    id: run.runId,
    createdAtMs: new Date(run.startedAt ?? run.createdAt).getTime(),
    run,
  }));
  const activityTimelineItems: CommentThreadTimelineItem[] = activityItems.map((activity) => ({
    kind: "activity",
    id: activity.id,
    createdAtMs: new Date(activity.createdAt).getTime(),
    activity,
  }));
  const kindOrder: Record<CommentThreadTimelineItem["kind"], number> = {
    activity: 0,
    comment: 1,
    run: 2,
  };
  return [...commentItems, ...runItems, ...activityTimelineItems].sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
    if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind];
    return a.id.localeCompare(b.id);
  });
}

export function toIssueTimelineDisclosureItems(timeline: CommentThreadTimelineItem[]) {
  return timeline.map<IssueTimelineDisclosureItem>((item) => ({
    key: commentThreadTimelineItemKey(item),
    kind: item.kind,
    createdAtMs: item.createdAtMs,
    ...(item.kind === "comment" ? { commentBody: item.comment.body } : {}),
    ...(item.kind === "run" ? { runStatus: item.run.status } : {}),
  }));
}

export function projectCommentThreadTimeline(
  timeline: CommentThreadTimelineItem[],
  selection: IssueTimelineDisclosureSelection<IssueTimelineDisclosureItem>,
): CommentThreadTimelineRenderItem[] {
  if (selection.hidden.length === 0) return timeline;
  const timelineByKey = new Map(
    timeline.map((item) => [commentThreadTimelineItemKey(item), item]),
  );
  const resolve = (items: IssueTimelineDisclosureItem[]) => items
    .map((item) => timelineByKey.get(item.key))
    .filter((item): item is CommentThreadTimelineItem => Boolean(item));
  return [
    ...resolve(selection.visibleHead),
    {
      kind: "disclosure",
      id: "middle",
      createdAtMs: selection.hidden[0]?.createdAtMs ?? 0,
      hiddenCount: selection.hidden.length,
    },
    ...resolve(selection.visibleTail),
  ];
}

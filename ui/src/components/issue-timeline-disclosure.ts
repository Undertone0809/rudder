export const ISSUE_TIMELINE_ITEM_GAP_PX = 12;
export const ISSUE_TIMELINE_MIN_HIDDEN_ITEMS = 4;
export const ISSUE_TIMELINE_MAX_REVEAL_ITEMS = 24;

const MIN_BATCH_BUDGET_PX = 640;
const MAX_BATCH_BUDGET_PX = 900;
const COMMENT_MIN_HEIGHT_PX = 144;
const COMMENT_MAX_HEIGHT_PX = 720;
const COMMENT_BASE_HEIGHT_PX = 112;
const COMMENT_LINE_HEIGHT_PX = 20;
const COMMENT_IMAGE_HEIGHT_PX = 240;
const COMMENT_HORIZONTAL_PADDING_PX = 32;
const COMMENT_AVERAGE_CHARACTER_WIDTH_PX = 7;

export type IssueTimelineDisclosureKind = "activity" | "comment" | "run";

export interface IssueTimelineDisclosureItem {
  key: string;
  kind: IssueTimelineDisclosureKind;
  createdAtMs: number;
  commentBody?: string;
  runStatus?: string;
}

export interface IssueTimelineSortBoundary {
  key: string;
  kind: IssueTimelineDisclosureKind;
  createdAtMs: number;
}

export interface IssueTimelineDisclosureState {
  fullyExpanded: boolean;
  prefixBoundary: IssueTimelineSortBoundary | null;
  suffixBoundary: IssueTimelineSortBoundary | null;
}

export interface IssueTimelineDisclosureSelection<T extends IssueTimelineDisclosureItem> {
  hidden: T[];
  visibleHead: T[];
  visibleTail: T[];
}

const KIND_ORDER: Record<IssueTimelineDisclosureKind, number> = {
  activity: 0,
  comment: 1,
  run: 2,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function compareIssueTimelineItems(
  a: Pick<IssueTimelineDisclosureItem, "createdAtMs" | "kind" | "key">,
  b: Pick<IssueTimelineDisclosureItem, "createdAtMs" | "kind" | "key">,
) {
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return a.key.localeCompare(b.key);
}

function boundaryFor(item: IssueTimelineDisclosureItem): IssueTimelineSortBoundary {
  return {
    key: item.key,
    kind: item.kind,
    createdAtMs: item.createdAtMs,
  };
}

export function issueTimelineBatchBudget(scrollRootHeight: number) {
  return clamp(scrollRootHeight * 0.8, MIN_BATCH_BUDGET_PX, MAX_BATCH_BUDGET_PX);
}

export function estimateIssueTimelineCommentVisualLines(body: string, timelineWidth: number) {
  const usableWidth = Math.max(1, timelineWidth - COMMENT_HORIZONTAL_PADDING_PX);
  const charactersPerLine = Math.max(
    1,
    Math.floor(usableWidth / COMMENT_AVERAGE_CHARACTER_WIDTH_PX),
  );
  const lines = body.split(/\r?\n/u);
  return Math.max(1, lines.reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / charactersPerLine)),
    0,
  ));
}

function countMarkdownImages(body: string) {
  const markdownImages = body.match(/!\[[^\]]*\]\([^\n)]+\)/gu)?.length ?? 0;
  const htmlImages = body.match(/<img\b/giu)?.length ?? 0;
  return markdownImages + htmlImages;
}

export function estimateIssueTimelineItemHeight(
  item: IssueTimelineDisclosureItem,
  timelineWidth: number,
) {
  if (item.kind === "activity") return 40;
  if (item.kind === "run") {
    return item.runStatus === "queued" || item.runStatus === "running" ? 320 : 52;
  }

  const body = item.commentBody ?? "";
  const visualLines = estimateIssueTimelineCommentVisualLines(body, timelineWidth);
  return clamp(
    COMMENT_BASE_HEIGHT_PX
      + visualLines * COMMENT_LINE_HEIGHT_PX
      + countMarkdownImages(body) * COMMENT_IMAGE_HEIGHT_PX,
    COMMENT_MIN_HEIGHT_PX,
    COMMENT_MAX_HEIGHT_PX,
  );
}

function estimatedRangeHeight(
  items: IssueTimelineDisclosureItem[],
  timelineWidth: number,
) {
  return items.reduce((total, item, index) => (
    total
      + estimateIssueTimelineItemHeight(item, timelineWidth)
      + (index > 0 ? ISSUE_TIMELINE_ITEM_GAP_PX : 0)
  ), 0);
}

function takeWithinBudget(
  items: IssueTimelineDisclosureItem[],
  budget: number,
  timelineWidth: number,
  fromEnd = false,
) {
  let height = 0;
  let count = 0;
  const ordered = fromEnd ? [...items].reverse() : items;
  for (const item of ordered) {
    const nextHeight = estimateIssueTimelineItemHeight(item, timelineWidth)
      + (count > 0 ? ISSUE_TIMELINE_ITEM_GAP_PX : 0);
    if (count > 0 && height + nextHeight > budget) break;
    height += nextHeight;
    count += 1;
  }
  return count;
}

function shouldKeepHiddenRange(
  hidden: IssueTimelineDisclosureItem[],
  batchBudget: number,
  timelineWidth: number,
) {
  return hidden.length >= ISSUE_TIMELINE_MIN_HIDDEN_ITEMS
    && estimatedRangeHeight(hidden, timelineWidth) >= batchBudget * 0.5;
}

export function createInitialIssueTimelineDisclosure(
  inputItems: IssueTimelineDisclosureItem[],
  scrollRootHeight: number,
  timelineWidth: number,
): IssueTimelineDisclosureState {
  const items = [...inputItems].sort(compareIssueTimelineItems);
  if (items.length === 0 || scrollRootHeight <= 0 || timelineWidth <= 0) {
    return { fullyExpanded: true, prefixBoundary: null, suffixBoundary: null };
  }

  const batchBudget = issueTimelineBatchBudget(scrollRootHeight);
  const headCount = takeWithinBudget(items, batchBudget * 0.4, timelineWidth);
  const remainingAfterHead = items.slice(headCount);
  const tailCount = takeWithinBudget(
    remainingAfterHead,
    batchBudget * 0.8,
    timelineWidth,
    true,
  );
  const tailStart = Math.max(headCount, items.length - tailCount);
  const hidden = items.slice(headCount, tailStart);
  if (!shouldKeepHiddenRange(hidden, batchBudget, timelineWidth)) {
    return { fullyExpanded: true, prefixBoundary: null, suffixBoundary: null };
  }

  return {
    fullyExpanded: false,
    prefixBoundary: boundaryFor(items[Math.max(0, headCount - 1)]!),
    suffixBoundary: boundaryFor(items[tailStart]!),
  };
}

export function selectIssueTimelineDisclosureItems<T extends IssueTimelineDisclosureItem>(
  inputItems: T[],
  state: IssueTimelineDisclosureState,
): IssueTimelineDisclosureSelection<T> {
  const items = [...inputItems].sort(compareIssueTimelineItems);
  if (state.fullyExpanded || !state.prefixBoundary || !state.suffixBoundary) {
    return { hidden: [], visibleHead: items, visibleTail: [] };
  }

  const visibleHead: T[] = [];
  const hidden: T[] = [];
  const visibleTail: T[] = [];
  for (const item of items) {
    if (compareIssueTimelineItems(item, state.prefixBoundary) <= 0) {
      visibleHead.push(item);
    } else if (compareIssueTimelineItems(item, state.suffixBoundary) >= 0) {
      visibleTail.push(item);
    } else {
      hidden.push(item);
    }
  }
  return { hidden, visibleHead, visibleTail };
}

export function revealNextIssueTimelineBatch(
  inputItems: IssueTimelineDisclosureItem[],
  state: IssueTimelineDisclosureState,
  scrollRootHeight: number,
  timelineWidth: number,
): IssueTimelineDisclosureState {
  const selection = selectIssueTimelineDisclosureItems(inputItems, state);
  if (selection.hidden.length === 0) {
    return { fullyExpanded: true, prefixBoundary: null, suffixBoundary: null };
  }

  const batchBudget = issueTimelineBatchBudget(scrollRootHeight);
  const count = Math.min(
    ISSUE_TIMELINE_MAX_REVEAL_ITEMS,
    takeWithinBudget(selection.hidden, batchBudget, timelineWidth),
  );
  const nextPrefix = selection.hidden[Math.max(0, count - 1)]!;
  const nextState: IssueTimelineDisclosureState = {
    ...state,
    prefixBoundary: boundaryFor(nextPrefix),
  };
  const remainder = selectIssueTimelineDisclosureItems(inputItems, nextState).hidden;
  if (!shouldKeepHiddenRange(remainder, batchBudget, timelineWidth)) {
    return { fullyExpanded: true, prefixBoundary: null, suffixBoundary: null };
  }
  return nextState;
}

export function revealIssueTimelineTarget(
  inputItems: IssueTimelineDisclosureItem[],
  state: IssueTimelineDisclosureState,
  targetKey: string,
): IssueTimelineDisclosureState {
  if (state.fullyExpanded) return state;
  const selection = selectIssueTimelineDisclosureItems(inputItems, state);
  const target = selection.hidden.find((item) => item.key === targetKey);
  if (!target) return state;
  const nextState: IssueTimelineDisclosureState = {
    ...state,
    prefixBoundary: boundaryFor(target),
  };
  return selectIssueTimelineDisclosureItems(inputItems, nextState).hidden.length === 0
    ? { fullyExpanded: true, prefixBoundary: null, suffixBoundary: null }
    : nextState;
}


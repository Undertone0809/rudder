export type TimedLayoutInput = {
  id: string;
  startAt: Date | string;
  endAt: Date | string;
};

export type TimedLayoutItem<T extends TimedLayoutInput> = {
  event: T;
  column: number;
  columns: number;
  leftPct: number;
  widthPct: number;
};

function eventStart(event: TimedLayoutInput) {
  return new Date(event.startAt).getTime();
}

function eventEnd(event: TimedLayoutInput) {
  return new Date(event.endAt).getTime();
}

export function layoutTimedEvents<T extends TimedLayoutInput>(
  events: T[],
  options: { gutterPct?: number } = {},
): TimedLayoutItem<T>[] {
  const gutterPct = options.gutterPct ?? 1.2;
  const sorted = [...events].sort((a, b) => {
    const startDelta = eventStart(a) - eventStart(b);
    if (startDelta !== 0) return startDelta;
    const endDelta = eventEnd(a) - eventEnd(b);
    if (endDelta !== 0) return endDelta;
    return a.id.localeCompare(b.id);
  });
  const positioned = new Map<string, TimedLayoutItem<T>>();

  let cluster: T[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  function flushCluster() {
    if (cluster.length === 0) return;

    const columnEnds: number[] = [];
    const assignments = cluster.map((event) => {
      const start = eventStart(event);
      const end = eventEnd(event);
      let column = columnEnds.findIndex((columnEnd) => columnEnd <= start);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(end);
      } else {
        columnEnds[column] = end;
      }
      return { event, column };
    });
    const columns = Math.max(1, columnEnds.length);
    const totalGutter = Math.max(0, columns - 1) * gutterPct;
    const widthPct = (100 - totalGutter) / columns;

    for (const assignment of assignments) {
      positioned.set(assignment.event.id, {
        event: assignment.event,
        column: assignment.column,
        columns,
        leftPct: assignment.column * (widthPct + gutterPct),
        widthPct,
      });
    }

    cluster = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  }

  for (const event of sorted) {
    const start = eventStart(event);
    const end = eventEnd(event);
    if (cluster.length > 0 && start >= clusterEnd) {
      flushCluster();
    }
    cluster.push(event);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flushCluster();

  return events.map((event) => positioned.get(event.id) ?? {
    event,
    column: 0,
    columns: 1,
    leftPct: 0,
    widthPct: 100,
  });
}

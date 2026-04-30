export type TimedEventInput = {
  id: string;
  startAt: Date | string;
  endAt: Date | string;
};

export type TimedDaySegment<T extends TimedEventInput> = {
  id: string;
  event: T;
  startAt: Date;
  endAt: Date;
  startsBeforeDay: boolean;
  endsAfterDay: boolean;
};

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addLocalDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function clipTimedEventToDay<T extends TimedEventInput>(event: T, day: Date): TimedDaySegment<T> | null {
  const startAt = new Date(event.startAt);
  const endAt = new Date(event.endAt);
  if (!(endAt.getTime() > startAt.getTime())) return null;

  const dayStart = startOfLocalDay(day);
  const nextDayStart = startOfLocalDay(addLocalDays(dayStart, 1));
  if (endAt.getTime() <= dayStart.getTime() || startAt.getTime() >= nextDayStart.getTime()) {
    return null;
  }

  return {
    id: `${event.id}:${localDateKey(dayStart)}`,
    event,
    startAt: new Date(Math.max(startAt.getTime(), dayStart.getTime())),
    endAt: new Date(Math.min(endAt.getTime(), nextDayStart.getTime())),
    startsBeforeDay: startAt.getTime() < dayStart.getTime(),
    endsAfterDay: endAt.getTime() > nextDayStart.getTime(),
  };
}

export function timedEventSegmentsForDay<T extends TimedEventInput>(events: T[], day: Date) {
  return events.flatMap((event) => {
    const segment = clipTimedEventToDay(event, day);
    return segment ? [segment] : [];
  });
}

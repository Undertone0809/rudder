export type SlidingDatePreset = "1d" | "24h" | "7d" | "15d" | "30d" | "mtd" | "ytd" | "all" | "custom";

export function floorDateToMinuteIso(date: Date): string {
  const floored = new Date(date);
  floored.setSeconds(0, 0);
  return floored.toISOString();
}

function localDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultCustomDateRange(now = new Date()): { from: string; to: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  return {
    from: localDateInputValue(from),
    to: localDateInputValue(now),
  };
}

export function resolvePresetDateRange({
  preset,
  customFrom = "",
  customTo = "",
  now = new Date(),
  dayWindowMode = "inclusive",
}: {
  preset: SlidingDatePreset;
  customFrom?: string;
  customTo?: string;
  now?: Date;
  dayWindowMode?: "inclusive" | "lookback";
}): { from: string; to: string; customReady: boolean } {
  if (preset === "custom") {
    const fromDate = customFrom ? new Date(`${customFrom}T00:00:00`) : null;
    const toDate = customTo ? new Date(`${customTo}T23:59:59.999`) : null;
    const valid =
      !!fromDate
      && !!toDate
      && Number.isFinite(fromDate.getTime())
      && Number.isFinite(toDate.getTime())
      && fromDate <= toDate;
    return {
      from: valid ? fromDate.toISOString() : "",
      to: valid ? toDate.toISOString() : "",
      customReady: valid,
    };
  }

  if (preset === "all") {
    return { from: "", to: "", customReady: true };
  }

  const to = floorDateToMinuteIso(now);
  if (preset === "1d") {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
      to: now.toISOString(),
      customReady: true,
    };
  }
  if (preset === "24h") {
    return {
      from: new Date(new Date(to).getTime() - 24 * 60 * 60 * 1000).toISOString(),
      to,
      customReady: true,
    };
  }
  if (preset === "mtd") {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      to,
      customReady: true,
    };
  }
  if (preset === "ytd") {
    return {
      from: new Date(now.getFullYear(), 0, 1).toISOString(),
      to,
      customReady: true,
    };
  }

  const days = preset === "7d" ? 7 : preset === "15d" ? 15 : 30;
  const startOffset = dayWindowMode === "lookback" ? days : days - 1;
  return {
    from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - startOffset, 0, 0, 0, 0).toISOString(),
    to,
    customReady: true,
  };
}

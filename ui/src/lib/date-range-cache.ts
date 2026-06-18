export type SlidingDatePreset = "7d" | "15d" | "30d" | "mtd" | "ytd" | "all" | "custom";

export function floorDateToMinuteIso(date: Date): string {
  const floored = new Date(date);
  floored.setSeconds(0, 0);
  return floored.toISOString();
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
    return {
      from: fromDate ? fromDate.toISOString() : "",
      to: toDate ? toDate.toISOString() : "",
      customReady: !!customFrom && !!customTo,
    };
  }

  if (preset === "all") {
    return { from: "", to: "", customReady: true };
  }

  const to = floorDateToMinuteIso(now);
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

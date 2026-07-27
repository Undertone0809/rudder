import { defaultCustomDateRange, floorDateToMinuteIso, resolvePresetDateRange } from "@/lib/date-range-cache";
import type { CostTrendGranularity } from "@rudderhq/shared";
import { useEffect, useMemo, useRef, useState } from "react";

export type DatePreset = "24h" | "7d" | "30d" | "ytd" | "all" | "custom";

export const PRESET_LABELS: Record<DatePreset, string> = {
  "24h": "Last 24 Hours",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  ytd: "Year to Date",
  all: "All Time",
  custom: "Custom",
};

export const PRESET_KEYS: DatePreset[] = ["24h", "7d", "30d", "ytd", "all", "custom"];

export interface UseDateRangeResult {
  preset: DatePreset;
  setPreset: (p: DatePreset) => void;
  customFrom: string;
  setCustomFrom: (v: string) => void;
  customTo: string;
  setCustomTo: (v: string) => void;
  /** resolved iso strings ready to pass to api calls; empty string means unbounded */
  from: string;
  to: string;
  /** false when preset=custom but both dates are not yet selected */
  customReady: boolean;
  customError: string | null;
  trendGranularity: CostTrendGranularity;
}

export function useDateRange(initialPreset: DatePreset = "24h"): UseDateRangeResult {
  const [preset, setPreset] = useState<DatePreset>(initialPreset);
  const [initialCustomRange] = useState(() => defaultCustomDateRange());
  const [customFrom, setCustomFrom] = useState(initialCustomRange.from);
  const [customTo, setCustomTo] = useState(initialCustomRange.to);

  // tick at the next calendar minute boundary, then every 60s, so sliding presets
  // (7d, 30d) advance their upper bound in sync with wall clock minutes rather than
  // drifting by the mount offset.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [minuteTick, setMinuteTick] = useState(() => floorDateToMinuteIso(new Date()));
  useEffect(() => {
    const now = new Date();
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    const timeout = setTimeout(() => {
      setMinuteTick(floorDateToMinuteIso(new Date()));
      intervalRef.current = setInterval(
        () => setMinuteTick(floorDateToMinuteIso(new Date())),
        60_000,
      );
    }, msToNextMinute);
    return () => {
      clearTimeout(timeout);
      if (intervalRef.current != null) clearInterval(intervalRef.current);
    };
  }, []);

  const { from, to } = useMemo(() => {
    return resolvePresetDateRange({
      preset,
      customFrom,
      customTo,
      now: new Date(minuteTick),
      dayWindowMode: "lookback",
    });
  // minuteTick drives re-evaluation of sliding presets once per minute.
  }, [preset, customFrom, customTo, minuteTick]);

  const customReady = preset !== "custom" || (!!from && !!to);
  const customError =
    preset === "custom" && customFrom && customTo && !customReady
      ? "Start date must be on or before end date."
      : null;

  return {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    from,
    to,
    customReady,
    customError,
    trendGranularity: preset === "24h" ? "hour" : "day",
  };
}

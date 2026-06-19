import { keepPreviousData } from "@tanstack/react-query";

export const SKILL_ANALYTICS_STALE_TIME_MS = 120_000;

export const skillAnalyticsQueryOptions = {
  staleTime: SKILL_ANALYTICS_STALE_TIME_MS,
  placeholderData: keepPreviousData,
} as const;

export const ISSUE_REFRESH_INTERVAL_MS = 5000;

export const ISSUE_REFRESH_QUERY_OPTIONS = {
  refetchInterval: ISSUE_REFRESH_INTERVAL_MS,
  refetchIntervalInBackground: false,
  refetchOnReconnect: "always",
  refetchOnWindowFocus: "always",
} as const;

export function createBrowserPopupRateLimiter(options: {
  maxPopups?: number;
  windowMs?: number;
  now?: () => number;
} = {}) {
  const maxPopups = options.maxPopups ?? 8;
  const windowMs = options.windowMs ?? 10_000;
  const now = options.now ?? Date.now;
  let acceptedAt: number[] = [];

  return () => {
    const current = now();
    acceptedAt = acceptedAt.filter((timestamp) => current - timestamp < windowMs);
    if (acceptedAt.length >= maxPopups) return false;
    acceptedAt.push(current);
    return true;
  };
}

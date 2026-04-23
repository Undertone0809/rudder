/**
 * Canonical status & priority color definitions.
 *
 * Every component that renders a status indicator (StatusIcon, StatusBadge,
 * agent status dots, etc.) should import from here so colors stay consistent.
 */

// ---------------------------------------------------------------------------
// Issue status colors
// ---------------------------------------------------------------------------

/** StatusIcon circle: text + border classes */
export const issueStatusIcon: Record<string, string> = {
  backlog: "text-muted-foreground border-muted-foreground",
  todo: "text-blue-600 border-blue-600 dark:text-blue-400 dark:border-blue-400",
  in_progress: "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400",
  in_review: "text-violet-600 border-violet-600 dark:text-violet-400 dark:border-violet-400",
  done: "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400",
  cancelled: "text-neutral-500 border-neutral-500",
  blocked: "text-red-600 border-red-600 dark:text-red-400 dark:border-red-400",
};

export const issueStatusIconDefault = "text-muted-foreground border-muted-foreground";

/** Text-only color for issue statuses (dropdowns, labels) */
export const issueStatusText: Record<string, string> = {
  backlog: "text-muted-foreground",
  todo: "text-blue-600 dark:text-blue-400",
  in_progress: "text-yellow-600 dark:text-yellow-400",
  in_review: "text-violet-600 dark:text-violet-400",
  done: "text-green-600 dark:text-green-400",
  cancelled: "text-neutral-500",
  blocked: "text-red-600 dark:text-red-400",
};

export const issueStatusTextDefault = "text-muted-foreground";

// ---------------------------------------------------------------------------
// Badge colors — used by StatusBadge for all entity types
// ---------------------------------------------------------------------------

export const statusBadge: Record<string, string> = {
  // Agent statuses
  active: "border-green-200/80 bg-green-100/85 text-green-800 dark:border-green-700/50 dark:bg-green-900/30 dark:text-green-200",
  running: "border-cyan-200/80 bg-cyan-100/85 text-cyan-800 dark:border-cyan-700/50 dark:bg-cyan-900/30 dark:text-cyan-200",
  paused: "border-orange-200/80 bg-orange-100/85 text-orange-800 dark:border-orange-700/50 dark:bg-orange-900/30 dark:text-orange-200",
  idle: "border-yellow-200/80 bg-yellow-100/85 text-yellow-800 dark:border-yellow-700/50 dark:bg-yellow-900/30 dark:text-yellow-200",
  archived: "border-[color:var(--border-soft)] bg-muted text-muted-foreground",

  // Goal statuses
  planned: "border-[color:var(--border-soft)] bg-muted text-muted-foreground",
  achieved: "border-green-200/80 bg-green-100/85 text-green-800 dark:border-green-700/50 dark:bg-green-900/30 dark:text-green-200",
  completed: "border-green-200/80 bg-green-100/85 text-green-800 dark:border-green-700/50 dark:bg-green-900/30 dark:text-green-200",

  // Run statuses
  failed: "border-red-200/80 bg-red-100/85 text-red-800 dark:border-red-700/50 dark:bg-red-900/30 dark:text-red-200",
  timed_out: "border-orange-200/80 bg-orange-100/85 text-orange-800 dark:border-orange-700/50 dark:bg-orange-900/30 dark:text-orange-200",
  succeeded: "border-green-200/80 bg-green-100/85 text-green-800 dark:border-green-700/50 dark:bg-green-900/30 dark:text-green-200",
  error: "border-red-200/80 bg-red-100/85 text-red-800 dark:border-red-700/50 dark:bg-red-900/30 dark:text-red-200",
  terminated: "border-red-200/80 bg-red-100/85 text-red-800 dark:border-red-700/50 dark:bg-red-900/30 dark:text-red-200",
  pending: "border-yellow-200/80 bg-yellow-100/85 text-yellow-800 dark:border-yellow-700/50 dark:bg-yellow-900/30 dark:text-yellow-200",

  // Approval statuses
  pending_approval: "border-amber-200/80 bg-amber-100/85 text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/30 dark:text-amber-200",
  revision_requested: "border-amber-200/80 bg-amber-100/85 text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/30 dark:text-amber-200",
  approved: "border-green-200/80 bg-green-100/85 text-green-800 dark:border-green-700/50 dark:bg-green-900/30 dark:text-green-200",
  rejected: "border-red-200/80 bg-red-100/85 text-red-800 dark:border-red-700/50 dark:bg-red-900/30 dark:text-red-200",

  // Issue statuses — consistent hues with issueStatusIcon above
  backlog: "border-[color:var(--border-soft)] bg-muted text-muted-foreground",
  todo: "border-blue-200/80 bg-blue-100/85 text-blue-800 dark:border-blue-700/50 dark:bg-blue-900/30 dark:text-blue-200",
  in_progress: "border-yellow-200/80 bg-yellow-100/85 text-yellow-800 dark:border-yellow-700/50 dark:bg-yellow-900/30 dark:text-yellow-200",
  in_review: "border-violet-200/80 bg-violet-100/85 text-violet-800 dark:border-violet-700/50 dark:bg-violet-900/30 dark:text-violet-200",
  blocked: "border-red-200/80 bg-red-100/85 text-red-800 dark:border-red-700/50 dark:bg-red-900/30 dark:text-red-200",
  done: "border-green-200/80 bg-green-100/85 text-green-800 dark:border-green-700/50 dark:bg-green-900/30 dark:text-green-200",
  cancelled: "border-[color:var(--border-soft)] bg-muted text-muted-foreground",
};

export const statusBadgeDefault = "border-[color:var(--border-soft)] bg-muted text-muted-foreground";

// ---------------------------------------------------------------------------
// Agent status dot — solid background for small indicator dots
// ---------------------------------------------------------------------------

export const agentStatusDot: Record<string, string> = {
  running: "bg-cyan-400 animate-pulse",
  active: "bg-green-400",
  paused: "bg-yellow-400",
  idle: "bg-yellow-400",
  pending_approval: "bg-amber-400",
  error: "bg-red-400",
  archived: "bg-neutral-400",
};

export const agentStatusDotDefault = "bg-neutral-400";

// ---------------------------------------------------------------------------
// Priority colors
// ---------------------------------------------------------------------------

export const priorityColor: Record<string, string> = {
  critical: "text-red-600 dark:text-red-400",
  high: "text-orange-600 dark:text-orange-400",
  medium: "text-yellow-600 dark:text-yellow-400",
  low: "text-blue-600 dark:text-blue-400",
};

export const priorityColorDefault = "text-yellow-600 dark:text-yellow-400";

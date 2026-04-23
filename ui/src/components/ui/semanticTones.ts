export type SemanticTone = "info" | "success" | "warn" | "error";

export const semanticNoticeToneClasses: Record<SemanticTone, string> = {
  info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-500/25 dark:bg-sky-950/60 dark:text-sky-100",
  success:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-950/60 dark:text-emerald-100",
  warn: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-950/60 dark:text-amber-100",
  error: "border-red-300 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-950/60 dark:text-red-100",
};

export const semanticBadgeToneClasses: Record<SemanticTone, string> = {
  info: "border-sky-300/80 bg-sky-50/90 text-sky-800 dark:border-sky-500/25 dark:bg-sky-950/40 dark:text-sky-200",
  success:
    "border-emerald-300/80 bg-emerald-50/90 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-950/40 dark:text-emerald-200",
  warn:
    "border-amber-300/80 bg-amber-50/90 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200",
  error: "border-red-300/80 bg-red-50/90 text-red-800 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-200",
};

export const semanticTextToneClasses: Record<SemanticTone, string> = {
  info: "text-sky-800 dark:text-sky-200",
  success: "text-emerald-800 dark:text-emerald-200",
  warn: "text-amber-800 dark:text-amber-200",
  error: "text-red-800 dark:text-red-200",
};

export const semanticDotToneClasses: Record<SemanticTone, string> = {
  info: "bg-sky-500 dark:bg-sky-400",
  success: "bg-emerald-500 dark:bg-emerald-400",
  warn: "bg-amber-500 dark:bg-amber-400",
  error: "bg-red-500 dark:bg-red-400",
};

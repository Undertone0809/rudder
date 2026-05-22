export const DEFAULT_OPERATOR_DISPLAY_NAME = "You";

export function resolveOperatorDisplayName(
  nickname?: string | null,
  fallback: string = DEFAULT_OPERATOR_DISPLAY_NAME,
): string {
  return nickname?.trim() || fallback;
}

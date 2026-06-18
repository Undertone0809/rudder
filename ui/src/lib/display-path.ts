const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SHORT_UUID_LENGTH = 12;

export function formatShortUuid(value: string): string {
  return value.replace(/-/g, "").slice(0, SHORT_UUID_LENGTH).toLowerCase();
}

export function formatDisplayPath(value: string): string {
  return value.replace(UUID_PATTERN, (uuid) => formatShortUuid(uuid));
}

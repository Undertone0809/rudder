function sanitizedObjectKey(
  key: string,
  output: Record<string, unknown>,
): string {
  const base = key.replaceAll("\u0000", "\uFFFD");
  if (!Object.hasOwn(output, base)) return base;

  let suffix = 1;
  let candidate = `${base}-${suffix}`;
  while (Object.hasOwn(output, candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

export function sanitizePostgresJsonValue<T>(value: T): T {
  if (typeof value === "string") {
    return value.replaceAll("\u0000", "\uFFFD") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePostgresJsonValue(item)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[sanitizedObjectKey(key, output)] = sanitizePostgresJsonValue(item);
  }
  return output as T;
}

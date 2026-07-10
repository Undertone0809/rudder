const MAX_ERROR_CAUSE_DEPTH = 8;

type ErrorRecord = Record<string, unknown>;

function isErrorRecord(value: unknown): value is ErrorRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Matches PostgreSQL errors whether a driver exposes them directly or an ORM
 * wraps them in one or more standard `cause` properties.
 */
export function isPostgresError(
  error: unknown,
  code: string,
  constraintName?: string,
) {
  let current = error;
  const seen = new Set<object>();

  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    if (!isErrorRecord(current) || seen.has(current)) return false;
    seen.add(current);

    const hasExplicitConstraint = "constraint" in current || "constraint_name" in current;
    if (
      current.code === code
      && (
        constraintName === undefined
        || current.constraint === constraintName
        || current.constraint_name === constraintName
        || (
          !hasExplicitConstraint
          && typeof current.message === "string"
          && current.message.includes(constraintName)
        )
      )
    ) {
      return true;
    }

    current = current.cause;
  }

  return false;
}

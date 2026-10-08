const MISSING = Symbol("missing field");

export interface CalendarBoundaryCase {
  field: string;
  variant: "missing" | "null" | "empty" | "wrong-type" | "unknown-enum";
  input: Record<string, unknown>;
}

export interface CalendarBoundaryOptions {
  wrongTypeOverrides?: Readonly<Record<string, unknown>>;
  enumFields?: readonly string[];
}

/** Build bounded, deterministic field-shape cases for the shared Zod schema and Rust HTTP parser. */
export function calendarBoundaryCases(
  base: Record<string, unknown>,
  fields: readonly string[],
  options: CalendarBoundaryOptions = {},
): CalendarBoundaryCase[] {
  const variants: Array<[CalendarBoundaryCase["variant"], unknown | typeof MISSING]> = [
    ["missing", MISSING],
    ["null", null],
    ["empty", ""],
  ];
  return fields.flatMap((field) => {
    const values = [...variants, ["wrong-type", options.wrongTypeOverrides?.[field] ?? {}] as const];
    if (options.enumFields?.includes(field)) values.push(["unknown-enum", "unrecognized_calendar_enum"]);
    return values.map(([variant, value]) => {
      const input = { ...base };
      if (value === MISSING) delete input[field];
      else input[field] = value;
      return { field, variant, input };
    });
  });
}

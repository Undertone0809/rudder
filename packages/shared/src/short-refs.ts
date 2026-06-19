export type ShortRefKind = "agent" | "issue_comment";

const SHORT_REF_PREFIX_BY_KIND: Record<ShortRefKind, string> = {
  agent: "agt",
  issue_comment: "cmt",
};

const SHORT_REF_KIND_BY_PREFIX = Object.fromEntries(
  Object.entries(SHORT_REF_PREFIX_BY_KIND).map(([kind, prefix]) => [prefix, kind]),
) as Record<string, ShortRefKind | undefined>;

const SHORT_REF_RE = /^([a-z]{3})_([0-9a-f]{8,32})$/i;

export interface ParsedShortRef {
  kind: ShortRefKind;
  prefix: string;
  ref: string;
}

export function shortRefFor(kind: ShortRefKind, id: string): string {
  const prefix = SHORT_REF_PREFIX_BY_KIND[kind];
  const compactId = id.trim().replace(/-/g, "").slice(0, 8).toLowerCase();
  if (!prefix || compactId.length < 8) {
    throw new Error(`Cannot build short ref for ${kind}`);
  }
  return `${prefix}_${compactId}`;
}

export function parseShortRef(value: string | null | undefined): ParsedShortRef | null {
  if (typeof value !== "string") return null;
  const ref = value.trim();
  const match = ref.match(SHORT_REF_RE);
  if (!match) return null;
  const kind = SHORT_REF_KIND_BY_PREFIX[match[1].toLowerCase()];
  if (!kind) return null;
  return {
    kind,
    prefix: match[2].toLowerCase(),
    ref: `${match[1].toLowerCase()}_${match[2].toLowerCase()}`,
  };
}

export function isShortRef(value: string | null | undefined): boolean {
  return parseShortRef(value) !== null;
}

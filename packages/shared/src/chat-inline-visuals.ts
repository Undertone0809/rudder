export const CODEX_INLINE_VISUAL_DIRECTIVE_PREFIX = "::codex-inline-vis{";
export const MAX_CODEX_INLINE_VISUALS = 3;

export type CodexInlineVisualDirectiveIssueCode =
  | "count_limit"
  | "duplicate_attribute"
  | "invalid_file"
  | "malformed_attributes"
  | "missing_file"
  | "unknown_attribute"
  | "unterminated";

export interface CodexInlineVisualDirective {
  file: string;
  index: number;
  raw: string;
  start: number;
  end: number;
}

export interface CodexInlineVisualDirectiveIssue {
  code: CodexInlineVisualDirectiveIssueCode;
  raw: string;
  start: number;
  end: number;
}

export interface CodexInlineVisualDirectiveParseResult {
  directives: CodexInlineVisualDirective[];
  issues: CodexInlineVisualDirectiveIssue[];
}

export type ChatInlineVisualMapping =
  | { directiveIndex: number; file: string; status: "ready"; attachmentId: string }
  | { directiveIndex: number; file: string; status: "unavailable"; reason: string };

function issue(
  code: CodexInlineVisualDirectiveIssueCode,
  raw: string,
  start: number,
  end: number,
): CodexInlineVisualDirectiveIssue {
  return { code, raw, start, end };
}

function isAllowedVisualBasename(file: string) {
  return (
    file.length > 5
    && file.length <= 255
    && !file.startsWith(".")
    && !file.includes("/")
    && !file.includes("\\")
    && !file.includes("\0")
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/.test(file)
  );
}

function parseAttributes(rawAttributes: string):
  | { file: string }
  | { code: CodexInlineVisualDirectiveIssueCode } {
  if (/[\r\n]/.test(rawAttributes)) return { code: "malformed_attributes" };
  const attributes = new Map<string, string>();
  const attributePattern = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"([^"\r\n]*)"/gy;
  let cursor = 0;

  while (cursor < rawAttributes.length) {
    while (/\s/.test(rawAttributes[cursor] ?? "")) cursor += 1;
    if (cursor >= rawAttributes.length) break;
    attributePattern.lastIndex = cursor;
    const match = attributePattern.exec(rawAttributes);
    if (!match || match.index !== cursor) return { code: "malformed_attributes" };
    const name = match[1]!;
    if (attributes.has(name)) return { code: "duplicate_attribute" };
    attributes.set(name, match[2]!);
    cursor = attributePattern.lastIndex;
  }

  for (const name of attributes.keys()) {
    if (name !== "file") return { code: "unknown_attribute" };
  }
  const file = attributes.get("file");
  if (file === undefined) return { code: "missing_file" };
  if (!isAllowedVisualBasename(file)) return { code: "invalid_file" };
  return { file };
}

function isInsideMarkdownFence(body: string, offset: number) {
  let fencedBy: "```" | "~~~" | null = null;
  let lineStart = 0;
  while (lineStart < offset) {
    const lineEnd = body.indexOf("\n", lineStart);
    const boundedEnd = lineEnd < 0 || lineEnd > offset ? offset : lineEnd;
    const line = body.slice(lineStart, boundedEnd).trimStart();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      const marker = line.slice(0, 3) as "```" | "~~~";
      if (fencedBy === marker) fencedBy = null;
      else if (fencedBy === null) fencedBy = marker;
    }
    if (lineEnd < 0 || lineEnd >= offset) break;
    lineStart = lineEnd + 1;
  }
  return fencedBy !== null;
}

export function parseCodexInlineVisualDirectives(
  body: string,
): CodexInlineVisualDirectiveParseResult {
  const directives: CodexInlineVisualDirective[] = [];
  const issues: CodexInlineVisualDirectiveIssue[] = [];
  let cursor = 0;

  while (cursor < body.length) {
    const start = body.indexOf(CODEX_INLINE_VISUAL_DIRECTIVE_PREFIX, cursor);
    if (start < 0) break;
    const attributesStart = start + CODEX_INLINE_VISUAL_DIRECTIVE_PREFIX.length;
    const close = body.indexOf("}", attributesStart);
    if (close < 0) {
      issues.push(issue("unterminated", body.slice(start), start, body.length));
      break;
    }

    const end = close + 1;
    const raw = body.slice(start, end);
    if (isInsideMarkdownFence(body, start)) {
      cursor = end;
      continue;
    }
    const parsed = parseAttributes(body.slice(attributesStart, close));
    if ("code" in parsed) {
      issues.push(issue(parsed.code, raw, start, end));
    } else if (
      body.slice(body.lastIndexOf("\n", start - 1) + 1, start).trim().length > 0
      || body.slice(end, body.indexOf("\n", end) < 0 ? body.length : body.indexOf("\n", end)).trim().length > 0
    ) {
      // Valid directives are control records and must occupy their own logical line.
    } else if (directives.length >= MAX_CODEX_INLINE_VISUALS) {
      issues.push(issue("count_limit", raw, start, end));
    } else {
      directives.push({
        file: parsed.file,
        index: directives.length,
        raw,
        start,
        end,
      });
    }
    cursor = end;
  }

  return { directives, issues };
}

export function stripCodexInlineVisualDirectives(
  body: string,
  directives: readonly Pick<CodexInlineVisualDirective, "start" | "end">[],
) {
  let result = body;
  for (const directive of [...directives].sort((a, b) => b.start - a.start)) {
    let start = directive.start;
    let end = directive.end;
    const lineStart = result.lastIndexOf("\n", start - 1) + 1;
    const lineEndIndex = result.indexOf("\n", end);
    const lineEnd = lineEndIndex < 0 ? result.length : lineEndIndex;
    if (
      result.slice(lineStart, start).trim().length === 0
      && result.slice(end, lineEnd).trim().length === 0
    ) {
      start = lineStart;
      end = lineEndIndex < 0 ? lineEnd : lineEnd + 1;
    }
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

export function chatInlineVisualMappingsFromStructuredPayload(
  payload: Record<string, unknown> | null | undefined,
): ChatInlineVisualMapping[] {
  const values = Array.isArray(payload?.inlineVisuals) ? payload.inlineVisuals : [];
  const mappings: ChatInlineVisualMapping[] = [];
  const seenIndexes = new Set<number>();
  for (const value of values) {
    if (mappings.length >= MAX_CODEX_INLINE_VISUALS) break;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const directiveIndex = entry.directiveIndex;
    const file = entry.file;
    if (
      typeof directiveIndex !== "number"
      || !Number.isInteger(directiveIndex)
      || directiveIndex < 0
      || directiveIndex >= MAX_CODEX_INLINE_VISUALS
      || seenIndexes.has(directiveIndex)
      || typeof file !== "string"
      || !isAllowedVisualBasename(file)
    ) continue;

    if (entry.status === "ready") {
      const attachmentId = typeof entry.attachmentId === "string" ? entry.attachmentId.trim() : "";
      if (!attachmentId) continue;
      mappings.push({ directiveIndex, file, status: "ready", attachmentId });
    } else if (entry.status === "unavailable") {
      const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
      if (!reason) continue;
      mappings.push({ directiveIndex, file, status: "unavailable", reason });
    } else {
      continue;
    }
    seenIndexes.add(directiveIndex);
  }
  return mappings.sort((a, b) => a.directiveIndex - b.directiveIndex);
}

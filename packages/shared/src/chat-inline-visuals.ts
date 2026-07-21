export const CODEX_INLINE_VISUAL_DIRECTIVE_PREFIX = "::codex-inline-vis{";
export const MAX_CODEX_INLINE_VISUALS = 3;
export const RUDDER_INLINE_VISUAL_START = ":::rudder-inline-visual:v1";
export const RUDDER_INLINE_VISUAL_END = ":::rudder-inline-visual:end";
export const RUDDER_INLINE_VISUAL_PLACEMENT_PREFIX = "::rudder-inline-vis{";
export const MAX_RUDDER_INLINE_VISUAL_FRAGMENT_BYTES = 64 * 1024;
export const MAX_RUDDER_INLINE_VISUAL_TOTAL_BYTES = 128 * 1024;
export const MAX_RUDDER_INLINE_VISUAL_REPLY_BYTES = 256 * 1024;

export type RudderInlineVisualEnvelopeIssueCode =
  | "count_limit"
  | "empty"
  | "fragment_size_limit"
  | "nested"
  | "reply_size_limit"
  | "total_size_limit"
  | "unterminated";

export interface RudderInlineVisualEnvelope {
  slot: number;
  fragment: string;
  byteSize: number;
  raw: string;
  start: number;
  end: number;
}

export interface RudderInlineVisualEnvelopeIssue {
  code: RudderInlineVisualEnvelopeIssueCode;
  slot: number | null;
  raw: string;
  start: number;
  end: number;
}

export interface RudderInlineVisualEnvelopeParseResult {
  envelopes: RudderInlineVisualEnvelope[];
  issues: RudderInlineVisualEnvelopeIssue[];
}

export interface RudderInlineVisualPlacement {
  slot: number;
  raw: string;
  start: number;
  end: number;
}

export type RudderInlineVisualMapping =
  | {
    version: 1;
    slot: number;
    file: string;
    status: "ready";
    attachmentId: string;
    contentType: "text/html";
    byteSize: number;
    sha256: string;
  }
  | {
    version: 1;
    slot: number;
    file: string;
    status: "unavailable";
    reason: string;
  };

type SourceLine = {
  start: number;
  contentEnd: number;
  end: number;
  content: string;
};

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function sourceLines(body: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < body.length) {
    const newline = body.indexOf("\n", start);
    const contentEnd = newline < 0 ? body.length : newline;
    const end = newline < 0 ? body.length : newline + 1;
    const rawContent = body.slice(start, contentEnd);
    lines.push({
      start,
      contentEnd,
      end,
      content: rawContent.endsWith("\r") ? rawContent.slice(0, -1) : rawContent,
    });
    start = end;
  }
  return lines;
}

type MarkdownFence = { marker: "`" | "~"; length: number };

function markdownFenceStart(line: string): MarkdownFence | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const run = match[2]!;
  if (run[0] === "`" && match[3]!.includes("`")) return null;
  return { marker: run[0] as "`" | "~", length: run.length };
}

function closesMarkdownFence(line: string, fence: MarkdownFence) {
  const pattern = fence.marker === "`" ? /^( {0,3})(`{3,})[ \t]*$/ : /^( {0,3})(~{3,})[ \t]*$/;
  const match = pattern.exec(line);
  return Boolean(match && match[2]!.length >= fence.length);
}

function isBlockQuoteOrIndentedCode(line: string) {
  return /^( {0,3})>/.test(line) || /^( {4}|\t)/.test(line);
}

export function parseRudderInlineVisualEnvelopes(
  body: string,
): RudderInlineVisualEnvelopeParseResult {
  const envelopes: RudderInlineVisualEnvelope[] = [];
  const issues: RudderInlineVisualEnvelopeIssue[] = [];
  const lines = sourceLines(body);
  const replyTooLarge = utf8ByteLength(body) > MAX_RUDDER_INLINE_VISUAL_REPLY_BYTES;
  let fence: MarkdownFence | null = null;
  let totalBytes = 0;
  let liveCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence) {
      if (closesMarkdownFence(line.content, fence)) fence = null;
      continue;
    }
    if (isBlockQuoteOrIndentedCode(line.content)) continue;
    const nextFence = markdownFenceStart(line.content);
    if (nextFence) {
      fence = nextFence;
      continue;
    }
    if (line.content !== RUDDER_INLINE_VISUAL_START) continue;

    const slot = liveCount < MAX_CODEX_INLINE_VISUALS ? liveCount : null;
    liveCount += 1;
    let closingIndex = -1;
    let nested = false;
    let depth = 1;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const content = lines[candidate]!.content;
      if (content === RUDDER_INLINE_VISUAL_START) {
        nested = true;
        depth += 1;
      }
      if (content === RUDDER_INLINE_VISUAL_END) {
        depth -= 1;
        if (depth === 0) {
          closingIndex = candidate;
          break;
        }
      }
    }

    if (closingIndex < 0) {
      issues.push({
        code: nested ? "nested" : "unterminated",
        slot,
        raw: body.slice(line.start),
        start: line.start,
        end: body.length,
      });
      break;
    }

    const closingLine = lines[closingIndex]!;
    const start = line.start;
    const end = closingLine.contentEnd;
    const raw = body.slice(start, end);
    const fragment = body.slice(line.end, closingLine.start).trim();
    const byteSize = utf8ByteLength(fragment);
    const code = nested
      ? "nested"
      : slot === null
        ? "count_limit"
        : replyTooLarge
          ? "reply_size_limit"
          : !fragment
            ? "empty"
            : byteSize > MAX_RUDDER_INLINE_VISUAL_FRAGMENT_BYTES
              ? "fragment_size_limit"
              : totalBytes + byteSize > MAX_RUDDER_INLINE_VISUAL_TOTAL_BYTES
                ? "total_size_limit"
                : null;
    if (code) {
      issues.push({ code, slot, raw, start, end });
    } else {
      envelopes.push({ slot: slot!, fragment, byteSize, raw, start, end });
      totalBytes += byteSize;
    }
    index = closingIndex;
  }

  return { envelopes, issues };
}

export function replaceRudderInlineVisualSources(
  body: string,
  replacements: readonly { start: number; end: number; replacement: string }[],
) {
  let result = body;
  for (const entry of [...replacements].sort((a, b) => b.start - a.start)) {
    let start = entry.start;
    let end = entry.end;
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
    const replacement = entry.replacement
      ? `${entry.replacement}${end <= result.length && result[end - 1] === "\n" ? "\n" : ""}`
      : "";
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result.trim();
}

export function parseRudderInlineVisualPlacements(body: string) {
  const placements: RudderInlineVisualPlacement[] = [];
  const issues: Array<{ raw: string; start: number; end: number }> = [];
  let fence: MarkdownFence | null = null;
  for (const line of sourceLines(body)) {
    if (fence) {
      if (closesMarkdownFence(line.content, fence)) fence = null;
      continue;
    }
    if (isBlockQuoteOrIndentedCode(line.content)) continue;
    const nextFence = markdownFenceStart(line.content);
    if (nextFence) {
      fence = nextFence;
      continue;
    }
    if (!line.content.startsWith(RUDDER_INLINE_VISUAL_PLACEMENT_PREFIX)) continue;
    const match = /^::rudder-inline-vis\{slot="([0-9]+)"\}$/.exec(line.content);
    const slot = match ? Number(match[1]) : -1;
    if (!match || slot < 0 || slot >= MAX_CODEX_INLINE_VISUALS || placements.some((entry) => entry.slot === slot)) {
      issues.push({ raw: line.content, start: line.start, end: line.contentEnd });
      continue;
    }
    placements.push({ slot, raw: line.content, start: line.start, end: line.contentEnd });
  }
  return { placements: placements.sort((a, b) => a.slot - b.slot), issues };
}

export function stripRudderInlineVisualPlacements(
  body: string,
  placements = parseRudderInlineVisualPlacements(body).placements,
) {
  return replaceRudderInlineVisualSources(
    body,
    placements.map((placement) => ({ ...placement, replacement: "" })),
  );
}

function isInlineVisualFilename(file: string, slot: number) {
  return file === `inline-visual-${slot + 1}.html`;
}

export function rudderInlineVisualMappingsFromStructuredPayload(
  payload: Record<string, unknown> | null | undefined,
): RudderInlineVisualMapping[] {
  const values = Array.isArray(payload?.inlineVisualsV1) ? payload.inlineVisualsV1 : [];
  const mappings: RudderInlineVisualMapping[] = [];
  const seenSlots = new Set<number>();
  for (const value of values) {
    if (mappings.length >= MAX_CODEX_INLINE_VISUALS) break;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const slot = entry.slot;
    const file = entry.file;
    if (
      entry.version !== 1
      || typeof slot !== "number"
      || !Number.isInteger(slot)
      || slot < 0
      || slot >= MAX_CODEX_INLINE_VISUALS
      || seenSlots.has(slot)
      || typeof file !== "string"
      || !isInlineVisualFilename(file, slot)
    ) continue;

    if (entry.status === "ready") {
      const attachmentId = typeof entry.attachmentId === "string" ? entry.attachmentId.trim() : "";
      const byteSize = typeof entry.byteSize === "number" && Number.isInteger(entry.byteSize) ? entry.byteSize : -1;
      const sha256 = typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : "";
      if (
        !attachmentId
        || entry.contentType !== "text/html"
        || byteSize < 1
        || byteSize > MAX_RUDDER_INLINE_VISUAL_FRAGMENT_BYTES
        || !/^[a-f0-9]{64}$/.test(sha256)
      ) continue;
      mappings.push({ version: 1, slot, file, status: "ready", attachmentId, contentType: "text/html", byteSize, sha256 });
    } else if (entry.status === "unavailable") {
      const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
      if (!reason || reason.length > 80) continue;
      mappings.push({ version: 1, slot, file, status: "unavailable", reason });
    } else {
      continue;
    }
    seenSlots.add(slot);
  }
  return mappings.sort((a, b) => a.slot - b.slot);
}

export function createRudderInlineVisualStreamSuppressor() {
  let carry = "";
  let visualDepth = 0;
  let fence: MarkdownFence | null = null;
  let passthroughLine = false;
  let discardVisualLine = false;
  let visibleText = "";

  const canPassThroughIncompleteLine = (line: string) => {
    if (!line || visualDepth > 0 || fence) return false;
    const content = line.replace(/\r$/, "");
    if (RUDDER_INLINE_VISUAL_START.startsWith(content)) return false;

    const leadingSpaces = /^( {0,3})/.exec(content)?.[1].length ?? 0;
    const remainder = content.slice(leadingSpaces);
    for (const marker of ["`", "~"] as const) {
      if (!remainder.startsWith(marker)) continue;
      const runLength = remainder.match(marker === "`" ? /^`+/ : /^~+/)?.[0].length ?? 0;
      if (runLength >= 3 || (runLength === remainder.length && runLength < 3)) return false;
    }
    return true;
  };

  const processLine = (rawLine: string, hasNewline: boolean) => {
    const rawContent = hasNewline ? rawLine.slice(0, -1) : rawLine;
    const content = rawContent.endsWith("\r") ? rawContent.slice(0, -1) : rawContent;
    if (visualDepth > 0) {
      if (content === RUDDER_INLINE_VISUAL_START) visualDepth += 1;
      if (content === RUDDER_INLINE_VISUAL_END) visualDepth -= 1;
      return "";
    }
    if (fence) {
      if (closesMarkdownFence(content, fence)) fence = null;
      return rawLine;
    }
    if (!isBlockQuoteOrIndentedCode(content)) {
      const nextFence = markdownFenceStart(content);
      if (nextFence) {
        fence = nextFence;
        return rawLine;
      }
      if (content === RUDDER_INLINE_VISUAL_START) {
        visualDepth = 1;
        return "";
      }
    }
    return rawLine;
  };

  return {
    push(text: string) {
      if (!text) return "";
      carry += text;
      let output = "";
      while (carry) {
        const newline = carry.indexOf("\n");
        if (discardVisualLine) {
          if (newline < 0) {
            carry = "";
            break;
          }
          carry = carry.slice(newline + 1);
          discardVisualLine = false;
          continue;
        }
        if (passthroughLine) {
          if (newline < 0) {
            output += carry;
            carry = "";
            break;
          }
          output += carry.slice(0, newline + 1);
          carry = carry.slice(newline + 1);
          passthroughLine = false;
          continue;
        }
        if (newline < 0) {
          const visualLine = carry.replace(/\r$/, "");
          if (
            visualDepth > 0
            && !RUDDER_INLINE_VISUAL_START.startsWith(visualLine)
            && !RUDDER_INLINE_VISUAL_END.startsWith(visualLine)
          ) {
            carry = "";
            discardVisualLine = true;
            break;
          }
          if (canPassThroughIncompleteLine(carry)) {
            output += carry;
            carry = "";
            passthroughLine = true;
          }
          break;
        }
        const line = carry.slice(0, newline + 1);
        carry = carry.slice(newline + 1);
        output += processLine(line, true);
      }
      visibleText += output;
      return output;
    },
    finish() {
      passthroughLine = false;
      discardVisualLine = false;
      if (!carry) return "";
      const line = carry;
      carry = "";
      if (visualDepth > 0 || RUDDER_INLINE_VISUAL_START.startsWith(line.replace(/\r$/, ""))) return "";
      const output = processLine(line, false);
      visibleText += output;
      return output;
    },
    get visibleText() {
      return visibleText;
    },
    get suppressing() {
      return visualDepth > 0;
    },
  };
}

export function redactRudderInlineVisualSources(body: string) {
  const suppressor = createRudderInlineVisualStreamSuppressor();
  return `${suppressor.push(body)}${suppressor.finish()}`.trim();
}

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

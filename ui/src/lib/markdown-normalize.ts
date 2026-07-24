function findClosingMarkdownToken(source: string, token: string, fromIndex: number) {
  const index = source.indexOf(token, fromIndex);
  return index >= 0 ? index : null;
}

function findClosingMarkdownParen(source: string, fromIndex: number) {
  let escaped = false;
  for (let index = fromIndex; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === ")") return index;
  }
  return null;
}

function normalizeWrappedInlineLinkDestinations(source: string) {
  return source.replace(
    /\[([^\]\n]+)\]\(((?:https?:\/\/|\/)[^)\n]*(?:\n[^\n)]*)+)\)/giu,
    (_match, label: string, destination: string) => {
      const normalizedDestination = destination.replace(/[ \t]*\n[ \t]*/g, "");
      return `[${label}](${normalizedDestination})`;
    },
  );
}

function normalizeCompactListMarkers(source: string) {
  return source
    .replace(
      /^([ \t]{0,3})([-+*])\[( |x|X)?\]([^\n]*)$/gmu,
      (_match, indent: string, marker: string, state: string | undefined, rest: string) => {
        const taskState = state && /^[xX]$/u.test(state) ? state : " ";
        const suffix = rest.trimStart();
        return `${indent}${marker} [${taskState}]${suffix ? ` ${suffix}` : ""}`;
      },
    )
    .replace(
      /^([ \t]{0,3})([-+*])\\(\[[^\]\n]*\])([^\n]*)$/gmu,
      (_match, indent: string, marker: string, bracketText: string, rest: string) => (
        `${indent}${marker} \\${bracketText}${rest}`
      ),
    );
}

function normalizeRelaxedMarkdownSegment(source: string) {
  return normalizeCompactListMarkers(normalizeWrappedInlineLinkDestinations(source));
}

export function normalizeEscapedMarkdownNewlines(source: string) {
  if (!source.includes("\\n")) return source;
  const escapedNewlineCount = source.match(/\\n/g)?.length ?? 0;
  if (escapedNewlineCount === 0) return source;

  const realNewlineCount = source.match(/\n/g)?.length ?? 0;
  const hasEscapedParagraph = source.includes("\\n\\n");
  const hasEscapedMarkdownList = /\\n\s*(?:[-*+]\s|\d+\.\s)/.test(source);
  const looksLikeEscapedBlock = realNewlineCount === 0 && escapedNewlineCount >= 3;

  if (!hasEscapedParagraph && !hasEscapedMarkdownList && !looksLikeEscapedBlock) {
    return source;
  }

  return source
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
}

const MARKDOWN_HTML_BREAK_RE = /(?:<br\s*\/?>|&lt;br\s*\/?&gt;)/giu;
const MARKDOWN_HTML_BREAK_ONLY_RE = /^(?:\s*(?:<br\s*\/?>|&lt;br\s*\/?&gt;)\s*)+$/iu;
const MARKDOWN_HTML_BREAK_AT_CURSOR_RE = /^(?:<br\s*\/?>|&lt;br\s*\/?&gt;)/iu;

function splitMarkdownHtmlBreakSegments(source: string): Array<{ text: string; protected: boolean }> {
  const parts: Array<{ text: string; protected: boolean }> = [];
  let cursor = 0;
  let plainStart = 0;

  function pushPlain(end: number) {
    if (end > plainStart) parts.push({ text: source.slice(plainStart, end), protected: false });
  }

  function pushProtected(end: number) {
    pushPlain(cursor);
    parts.push({ text: source.slice(cursor, end), protected: true });
    cursor = end;
    plainStart = end;
  }

  while (cursor < source.length) {
    const breakMatch = source.slice(cursor).match(MARKDOWN_HTML_BREAK_AT_CURSOR_RE);
    if (breakMatch) {
      cursor += breakMatch[0].length;
      continue;
    }

    const char = source[cursor];
    if (char === "`") {
      const fence = source.slice(cursor).match(/^`+/u)?.[0] ?? "`";
      const closing = findClosingMarkdownToken(source, fence, cursor + fence.length);
      pushProtected(closing !== null ? closing + fence.length : source.length);
      continue;
    }

    const linkStart = char === "[" ? cursor : char === "!" && source[cursor + 1] === "[" ? cursor + 1 : null;
    if (linkStart !== null) {
      const closeBracket = findClosingMarkdownToken(source, "]", linkStart + 1);
      if (closeBracket !== null && source[closeBracket + 1] === "(") {
        const closeParen = findClosingMarkdownParen(source, closeBracket + 2);
        if (closeParen !== null) {
          pushProtected(closeParen + 1);
          continue;
        }
      }
    }

    if (char === "<") {
      const closeAngle = findClosingMarkdownToken(source, ">", cursor + 1);
      if (closeAngle !== null) {
        pushProtected(closeAngle + 1);
        continue;
      }
    }

    cursor += 1;
  }

  pushPlain(source.length);
  return parts;
}

function replaceMarkdownHtmlBreaksInPlainText(source: string) {
  return source.split("\n").map((line) => {
    if (MARKDOWN_HTML_BREAK_ONLY_RE.test(line)) return "";
    return line.replace(MARKDOWN_HTML_BREAK_RE, "\n");
  }).join("\n");
}

function normalizeMarkdownHtmlBreaksOutsideFencedBlocks(source: string) {
  const output: string[] = [];
  const pendingPlainLines: string[] = [];
  let fenceMarker: "```" | "~~~" | null = null;

  function flushPlainLines() {
    if (pendingPlainLines.length === 0) return;
    const plainSource = pendingPlainLines.join("\n");
    output.push(
      splitMarkdownHtmlBreakSegments(plainSource).map((segment) => (
        segment.protected ? segment.text : replaceMarkdownHtmlBreaksInPlainText(segment.text)
      )).join(""),
    );
    pendingPlainLines.length = 0;
  }

  for (const line of source.split("\n")) {
    const fenceMatch = line.match(/^\s*(```|~~~)/u)?.[1] as "```" | "~~~" | undefined;
    if (fenceMatch && fenceMarker === null) {
      flushPlainLines();
      fenceMarker = fenceMatch;
      output.push(line);
      continue;
    }
    if (fenceMatch && fenceMarker === fenceMatch) {
      output.push(line);
      fenceMarker = null;
      continue;
    }
    if (fenceMarker !== null) {
      output.push(line);
      continue;
    }
    pendingPlainLines.push(line);
  }

  flushPlainLines();
  return output.join("\n");
}

export function normalizeMarkdownHtmlBreaks(source: string) {
  if (!/(?:<br|&lt;br)/iu.test(source)) return source;
  return normalizeMarkdownHtmlBreaksOutsideFencedBlocks(source);
}

export function normalizeRenderedMarkdownSource(source: string) {
  return normalizeRelaxedMarkdownSyntax(normalizeMarkdownHtmlBreaks(normalizeEscapedMarkdownNewlines(source)));
}

export function normalizeRelaxedMarkdownSyntax(source: string) {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const output: string[] = [];
  let plainSegment: string[] = [];
  let fenceMarker: "`" | "~" | null = null;

  const flushPlainSegment = () => {
    if (plainSegment.length === 0) return;
    output.push(normalizeRelaxedMarkdownSegment(plainSegment.join("\n")));
    plainSegment = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] as "`" | "~" | undefined;
      if (!fenceMarker) {
        flushPlainSegment();
        fenceMarker = marker ?? null;
        output.push(line);
        continue;
      }
      if (marker === fenceMarker) {
        output.push(line);
        fenceMarker = null;
        continue;
      }
    }

    if (fenceMarker) {
      output.push(line);
    } else {
      plainSegment.push(line);
    }
  }

  flushPlainSegment();
  return output.join("\n");
}

export type MarkdownSourceBoundaryMap = {
  rawSource: string;
  renderedSource: string;
  /**
   * Maps every UTF-16 boundary in `renderedSource` back to the corresponding
   * UTF-16 boundary in `rawSource`. This is intentionally a boundary map
   * (length + 1), rather than a character map, so inserted Markdown syntax can
   * collapse onto its raw insertion point while replacements still cover the
   * complete raw span.
   */
  renderedBoundaryToRaw: number[];
};

type SourceMatchBlock = {
  rawStart: number;
  renderedStart: number;
  length: number;
};

type SourceAlignmentSegment = {
  rawStart: number;
  rawEnd: number;
  renderedStart: number;
  renderedEnd: number;
};

type SourceAutomatonState = {
  length: number;
  link: number;
  firstEnd: number;
  next: Map<string, number>;
};

function longestCommonSourceRun(
  rawSource: string,
  renderedSource: string,
  segment: SourceAlignmentSegment,
): SourceMatchBlock | null {
  const states: SourceAutomatonState[] = [{
    length: 0,
    link: -1,
    firstEnd: segment.rawStart - 1,
    next: new Map(),
  }];
  let last = 0;
  for (let index = segment.rawStart; index < segment.rawEnd; index += 1) {
    const current = states.length;
    states.push({
      length: states[last]!.length + 1,
      link: 0,
      firstEnd: index,
      next: new Map(),
    });
    let cursor = last;
    const character = rawSource[index]!;
    while (cursor >= 0 && !states[cursor]!.next.has(character)) {
      states[cursor]!.next.set(character, current);
      cursor = states[cursor]!.link;
    }
    if (cursor >= 0) {
      const candidate = states[cursor]!.next.get(character)!;
      if (states[cursor]!.length + 1 === states[candidate]!.length) {
        states[current]!.link = candidate;
      } else {
        const clone = states.length;
        states.push({
          length: states[cursor]!.length + 1,
          link: states[candidate]!.link,
          firstEnd: states[candidate]!.firstEnd,
          next: new Map(states[candidate]!.next),
        });
        while (
          cursor >= 0
          && states[cursor]!.next.get(character) === candidate
        ) {
          states[cursor]!.next.set(character, clone);
          cursor = states[cursor]!.link;
        }
        states[candidate]!.link = clone;
        states[current]!.link = clone;
      }
    }
    last = current;
  }

  let stateIndex = 0;
  let matchedLength = 0;
  let best: SourceMatchBlock | null = null;
  for (
    let renderedIndex = segment.renderedStart;
    renderedIndex < segment.renderedEnd;
    renderedIndex += 1
  ) {
    const character = renderedSource[renderedIndex]!;
    while (stateIndex !== 0 && !states[stateIndex]!.next.has(character)) {
      stateIndex = states[stateIndex]!.link;
      matchedLength = Math.min(matchedLength, states[stateIndex]!.length);
    }
    const nextState = states[stateIndex]!.next.get(character);
    if (nextState === undefined) {
      stateIndex = 0;
      matchedLength = 0;
      continue;
    }
    stateIndex = nextState;
    matchedLength += 1;
    const state = states[stateIndex]!;
    const rawStart = state.firstEnd - matchedLength + 1;
    const renderedStart = renderedIndex - matchedLength + 1;
    if (
      !best
      || matchedLength > best.length
      || (
        matchedLength === best.length
        && (
          renderedStart < best.renderedStart
          || (
            renderedStart === best.renderedStart
            && rawStart < best.rawStart
          )
        )
      )
    ) {
      best = { rawStart, renderedStart, length: matchedLength };
    }
  }
  return best;
}

function matchingSourceBlocks(rawSource: string, renderedSource: string) {
  const blocks: SourceMatchBlock[] = [];
  const pending: SourceAlignmentSegment[] = [{
    rawStart: 0,
    rawEnd: rawSource.length,
    renderedStart: 0,
    renderedEnd: renderedSource.length,
  }];

  while (pending.length > 0) {
    const segment = pending.pop()!;
    let {
      rawStart,
      rawEnd,
      renderedStart,
      renderedEnd,
    } = segment;
    let prefixLength = 0;
    while (
      rawStart + prefixLength < rawEnd
      && renderedStart + prefixLength < renderedEnd
      && rawSource[rawStart + prefixLength]
        === renderedSource[renderedStart + prefixLength]
    ) {
      prefixLength += 1;
    }
    if (prefixLength > 0) {
      blocks.push({ rawStart, renderedStart, length: prefixLength });
      rawStart += prefixLength;
      renderedStart += prefixLength;
    }

    let suffixLength = 0;
    while (
      rawEnd - suffixLength > rawStart
      && renderedEnd - suffixLength > renderedStart
      && rawSource[rawEnd - suffixLength - 1]
        === renderedSource[renderedEnd - suffixLength - 1]
    ) {
      suffixLength += 1;
    }
    if (suffixLength > 0) {
      rawEnd -= suffixLength;
      renderedEnd -= suffixLength;
      blocks.push({ rawStart: rawEnd, renderedStart: renderedEnd, length: suffixLength });
    }
    if (rawStart >= rawEnd || renderedStart >= renderedEnd) continue;

    const commonRun = longestCommonSourceRun(rawSource, renderedSource, {
      rawStart,
      rawEnd,
      renderedStart,
      renderedEnd,
    });
    if (!commonRun || commonRun.length === 0) continue;
    blocks.push(commonRun);
    if (
      rawStart < commonRun.rawStart
      && renderedStart < commonRun.renderedStart
    ) {
      pending.push({
        rawStart,
        rawEnd: commonRun.rawStart,
        renderedStart,
        renderedEnd: commonRun.renderedStart,
      });
    }
    const rawAfter = commonRun.rawStart + commonRun.length;
    const renderedAfter = commonRun.renderedStart + commonRun.length;
    if (rawAfter < rawEnd && renderedAfter < renderedEnd) {
      pending.push({
        rawStart: rawAfter,
        rawEnd,
        renderedStart: renderedAfter,
        renderedEnd,
      });
    }
  }

  return blocks
    .sort((left, right) => (
      left.renderedStart - right.renderedStart
      || left.rawStart - right.rawStart
    ))
    .reduce<SourceMatchBlock[]>((merged, block) => {
      const previous = merged.at(-1);
      if (
        previous
        && previous.rawStart + previous.length === block.rawStart
        && previous.renderedStart + previous.length === block.renderedStart
      ) {
        previous.length += block.length;
      } else {
        merged.push({ ...block });
      }
      return merged;
    }, []);
}

function mapChangedSourceBoundaries(
  mapping: number[],
  rawStart: number,
  rawEnd: number,
  renderedStart: number,
  renderedEnd: number,
) {
  const rawLength = rawEnd - rawStart;
  const renderedLength = renderedEnd - renderedStart;
  if (renderedLength === 0) {
    mapping[renderedStart] = rawEnd;
    return;
  }
  for (let index = 0; index <= renderedLength; index += 1) {
    mapping[renderedStart + index] = rawStart
      + Math.round((index / renderedLength) * rawLength);
  }
}

/**
 * Aligns the Markdown string consumed by `react-markdown` with the immutable
 * raw message body that is hashed and persisted by response annotations.
 *
 * Rudder's rendering normalization is deliberately lossless for prose but may
 * insert Markdown syntax (compact tasks and bare mentions), remove wrapping
 * whitespace, or replace escaped/HTML line breaks. The alignment stays
 * monotonic and uses UTF-16 offsets, matching both mdast positions and DOM
 * Range offsets (including surrogate pairs and combining sequences).
 */
export function createMarkdownSourceBoundaryMap(
  rawSource: string,
  renderedSource: string,
): MarkdownSourceBoundaryMap {
  const renderedBoundaryToRaw = Array<number>(renderedSource.length + 1).fill(0);
  let rawCursor = 0;
  let renderedCursor = 0;
  for (const block of matchingSourceBlocks(rawSource, renderedSource)) {
    mapChangedSourceBoundaries(
      renderedBoundaryToRaw,
      rawCursor,
      block.rawStart,
      renderedCursor,
      block.renderedStart,
    );
    for (let index = 0; index <= block.length; index += 1) {
      renderedBoundaryToRaw[block.renderedStart + index] = block.rawStart + index;
    }
    rawCursor = block.rawStart + block.length;
    renderedCursor = block.renderedStart + block.length;
  }

  mapChangedSourceBoundaries(
    renderedBoundaryToRaw,
    rawCursor,
    rawSource.length,
    renderedCursor,
    renderedSource.length,
  );
  renderedBoundaryToRaw[0] = 0;
  renderedBoundaryToRaw[renderedSource.length] = rawSource.length;

  for (let index = 1; index < renderedBoundaryToRaw.length; index += 1) {
    renderedBoundaryToRaw[index] = Math.max(
      renderedBoundaryToRaw[index - 1]!,
      Math.min(rawSource.length, renderedBoundaryToRaw[index]!),
    );
  }

  return {
    rawSource,
    renderedSource,
    renderedBoundaryToRaw,
  };
}

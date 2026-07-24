export type MarkdownSourceBoundaryMap = {
  rawSource: string;
  renderedSource: string;
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
 * Builds a monotonic UTF-16 boundary map from a rendered/normalized string
 * back to the immutable raw source. Chat annotations and Markdown rendering
 * share this helper so client and server agree on replacement boundaries.
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

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

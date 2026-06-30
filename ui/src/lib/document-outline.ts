export type DocumentOutlineItem = {
  id: string;
  level: number;
  title: string;
  line: number;
  headingIndex: number;
  hidden: boolean;
};

type DocumentOutlineOptions = {
  includeHidden?: boolean;
};

function stripHeadingMarkup(input: string) {
  return input
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~]/g, "")
    .trim();
}

function slugifyHeading(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function isHiddenOutlineMarker(line: string) {
  const normalized = line.trim().toLowerCase();
  return /^<!--\s*(?:rudder-)?outline[-:\s]+hidden\s*-->$/.test(normalized)
    || /^<!--\s*rudder[-:\s]+hidden[-\s]+section\s*-->$/.test(normalized);
}

function previousNonEmptyLine(lines: string[], index: number) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor] ?? "";
    if (line.trim()) return line;
  }
  return "";
}

export function extractDocumentOutline(markdown: string, options: DocumentOutlineOptions = {}): DocumentOutlineItem[] {
  const outline: DocumentOutlineItem[] = [];
  const seenIds = new Map<string, number>();
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let renderedHeadingIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);

    if (fenceMatch) {
      const markerText = fenceMatch[1] ?? "";
      const marker = markerText.charAt(0) as "`" | "~";
      if (!fence) {
        fence = { marker, length: markerText.length };
        continue;
      }
      if (fence.marker === marker && markerText.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    if (fence) continue;

    const headingMatch = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
    if (!headingMatch) continue;

    const rawTitle = (headingMatch[2] ?? "").replace(/[ \t]+#+[ \t]*$/g, "");
    const title = stripHeadingMarkup(rawTitle);
    if (!title) {
      renderedHeadingIndex += 1;
      continue;
    }

    const baseId = slugifyHeading(title) || `section-${index + 1}`;
    const seenCount = seenIds.get(baseId) ?? 0;
    seenIds.set(baseId, seenCount + 1);
    const hidden = isHiddenOutlineMarker(previousNonEmptyLine(lines, index));

    if (!hidden || options.includeHidden) {
      outline.push({
        id: seenCount === 0 ? baseId : `${baseId}-${seenCount + 1}`,
        level: headingMatch[1]?.length ?? 1,
        title,
        line: index + 1,
        headingIndex: renderedHeadingIndex,
        hidden,
      });
    }
    renderedHeadingIndex += 1;
  }

  return outline;
}

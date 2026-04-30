export interface MessengerPreviewOptions {
  max?: number;
}

function truncateText(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function markdownHeadingText(line: string) {
  const match = line.match(/^#{1,6}\s*(.*?)\s*#*$/);
  const text = match?.[1]?.trim();
  return text ? text.replace(/[:：]\s*$/, "") : null;
}

function plainPreviewLine(line: string) {
  return line
    .trim()
    .replace(/^#{1,6}\s*(.*?)\s*#*$/, "$1")
    .replace(/^>\s*/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatMessengerPreview(value: string | null | undefined, options: MessengerPreviewOptions = {}) {
  const max = options.max ?? 140;
  const lines = (value ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const heading = markdownHeadingText(lines[0] ?? "");
  if (heading) {
    const detail = lines.slice(1).map(plainPreviewLine).find(Boolean);
    return truncateText(detail ? `${plainPreviewLine(heading)}: ${detail}` : plainPreviewLine(heading), max);
  }

  const first = plainPreviewLine(lines[0] ?? "");
  return first ? truncateText(first, max) : null;
}

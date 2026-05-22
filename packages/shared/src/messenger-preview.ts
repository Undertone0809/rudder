export interface MessengerPreviewOptions {
  max?: number;
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()\]]+/giu;

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function truncateText(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#x([\da-f]+);/giu, (_entity, codePoint: string) => {
      const parsed = Number.parseInt(codePoint, 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _entity;
    })
    .replace(/&#(\d+);/gu, (_entity, codePoint: string) => {
      const parsed = Number.parseInt(codePoint, 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _entity;
    })
    .replace(/&([a-z]+);/giu, (entity, name: string) => NAMED_HTML_ENTITIES[name.toLowerCase()] ?? entity);
}

function trimUrlToken(value: string) {
  return value.replace(/[\].,!?;:，。！？；：]+$/u, "");
}

function compactUrlLabel(value: string | null | undefined) {
  const raw = trimUrlToken(value?.trim() ?? "");
  if (!raw) return null;
  const normalized = raw.startsWith("www.") ? `https://${raw}` : raw;

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.replace(/^www\./iu, "");
    const pathParts = parsed.pathname.split("/").map((part) => part.trim()).filter(Boolean);
    const lastPathPart = pathParts.at(-1)
      ?.replace(/[-_]+/gu, " ")
      .replace(/\.html?$/iu, "")
      .trim();
    return lastPathPart ? `${hostname} · ${lastPathPart}` : hostname;
  } catch {
    return null;
  }
}

function stripBareUrlNoise(value: string) {
  const urls = Array.from(value.matchAll(URL_PATTERN), (match) => match[0]);
  if (urls.length === 0) return value;

  const withoutUrls = value
    .replace(URL_PATTERN, " ")
    .replace(/\[\s*\]/gu, " ")
    .replace(/\(\s*\)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (withoutUrls) return withoutUrls;

  return compactUrlLabel(urls[0]) ?? "";
}

function markdownHeadingText(line: string) {
  const match = decodeHtmlEntities(line).match(/^#{1,6}\s*(.*?)\s*#*$/);
  const text = match?.[1]?.trim();
  return text ? text.replace(/[:：]\s*$/, "") : null;
}

function plainPreviewLine(line: string) {
  return stripBareUrlNoise(decodeHtmlEntities(line)
    .trim()
    .replace(/^#{1,6}\s*(.*?)\s*#*$/, "$1")
    .replace(/^>\s*/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\s*((?:https?:\/\/|www\.)[^\]\s]+)\s*\]/giu, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim())
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

export function formatMessengerTitle(value: string | null | undefined, options: MessengerPreviewOptions = {}) {
  const max = options.max ?? 80;
  const lines = (value ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const line of lines) {
    const heading = markdownHeadingText(line);
    const title = plainPreviewLine(heading ?? line);
    if (title) return truncateText(title, max);
  }

  return null;
}

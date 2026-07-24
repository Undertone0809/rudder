import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 384 * 1024;

const CONVENTIONAL_ICON_PATHS = [
  "src/app/favicon.ico",
  "src/app/icon.ico",
  "src/app/icon.png",
  "src/app/icon.jpg",
  "src/app/icon.jpeg",
  "src/app/icon.webp",
  "src/app/icon.svg",
  "src/app/apple-icon.png",
  "app/favicon.ico",
  "app/icon.ico",
  "app/icon.png",
  "app/icon.jpg",
  "app/icon.jpeg",
  "app/icon.webp",
  "app/icon.svg",
  "app/apple-icon.png",
  "public/favicon.ico",
  "public/favicon.png",
  "public/favicon.svg",
  "public/icon.png",
  "public/icon.svg",
  "favicon.ico",
  "favicon.png",
  "favicon.svg",
] as const;

const HTML_PATHS = ["index.html", "public/index.html"] as const;
const MANIFEST_PATHS = [
  "public/site.webmanifest",
  "public/manifest.webmanifest",
  "public/manifest.json",
  "site.webmanifest",
  "manifest.webmanifest",
  "manifest.json",
] as const;

async function readBounded(filePath: string, maxBytes: number): Promise<Buffer | null> {
  let file: FileHandle | null = null;
  try {
    file = await open(filePath, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(stat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function htmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || null;
}

function decodeHtmlPath(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&#47;", "/");
}

function linkedPathsFromHtml(html: string) {
  const icons: string[] = [];
  const manifests: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = htmlAttribute(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
    const href = htmlAttribute(tag, "href");
    if (!href) continue;
    if (rel.includes("manifest")) manifests.push(decodeHtmlPath(href));
    if (rel.includes("icon") || rel.includes("apple-touch-icon")) {
      icons.push(decodeHtmlPath(href));
    }
  }
  return { icons, manifests };
}

function manifestIconPaths(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as { icons?: Array<{ src?: unknown; sizes?: unknown }> };
    if (!Array.isArray(parsed.icons)) return [];
    return parsed.icons
      .filter((entry) => entry && typeof entry.src === "string")
      .sort((left, right) => {
        const size = (value: unknown) => {
          const match = typeof value === "string" ? /(\d+)\s*x\s*(\d+)/i.exec(value) : null;
          return match ? Math.max(Number(match[1]), Number(match[2])) : Number.MAX_SAFE_INTEGER;
        };
        return size(left.sizes) - size(right.sizes);
      })
      .map((entry) => entry.src as string);
  } catch {
    return [];
  }
}

function safeSvg(buffer: Buffer): boolean {
  const text = buffer.toString("utf8");
  if (!/<svg[\s>]/i.test(text)) return false;
  return !/<(?:script|foreignObject)\b/i.test(text)
    && !/\bon[a-z]+\s*=/i.test(text)
    && !/\b(?:href|xlink:href)\s*=\s*["'](?!#|data:image\/)/i.test(text)
    && !/\burl\(\s*["']?(?!#|data:image\/)/i.test(text);
}

function imageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) {
    return "image/x-icon";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (safeSvg(buffer)) return "image/svg+xml";
  return null;
}

export function isSafeLocalAppIconDataUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^data:(image\/(?:png|jpeg|gif|webp|x-icon|svg\+xml));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match) return false;
  const encoded = match[2];
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0
    || buffer.length > MAX_ICON_BYTES
    || buffer.toString("base64") !== encoded) return false;
  return imageMime(buffer) === match[1];
}

async function confinedCandidate(root: string, base: string, value: string): Promise<string | null> {
  const withoutQuery = value.split(/[?#]/, 1)[0]?.trim() ?? "";
  if (!withoutQuery
    || withoutQuery.startsWith("//")
    || /^[a-z][a-z0-9+.-]*:/i.test(withoutQuery)
    || withoutQuery.includes("\0")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  const candidate = path.resolve(decoded.startsWith("/") ? root : base, decoded.replace(/^\/+/, ""));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const resolved = await realpath(candidate);
    const resolvedRelative = path.relative(root, resolved);
    return resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative) ? null : resolved;
  } catch {
    return null;
  }
}

async function iconDataUrl(root: string, base: string, value: string): Promise<string | null> {
  const candidate = await confinedCandidate(root, base, value);
  if (!candidate) return null;
  const buffer = await readBounded(candidate, MAX_ICON_BYTES);
  if (!buffer) return null;
  const mime = imageMime(buffer);
  return mime ? `data:${mime};base64,${buffer.toString("base64")}` : null;
}

export async function discoverLocalAppIcon(selectedRoot: string): Promise<string | null> {
  const root = await realpath(selectedRoot);
  const candidates: Array<{ base: string; value: string }> = [];
  const manifestCandidates: Array<{ base: string; value: string }> = [];

  for (const htmlRelative of HTML_PATHS) {
    const htmlPath = path.join(root, htmlRelative);
    const buffer = await readBounded(htmlPath, MAX_METADATA_BYTES);
    if (!buffer) continue;
    const linked = linkedPathsFromHtml(buffer.toString("utf8"));
    const webRoot = htmlRelative.startsWith("public/") ? path.join(root, "public") : root;
    for (const value of linked.icons) candidates.push({ base: webRoot, value });
    for (const value of linked.manifests) manifestCandidates.push({ base: webRoot, value });
  }

  for (const value of MANIFEST_PATHS) manifestCandidates.push({ base: root, value });
  for (const manifest of manifestCandidates) {
    const manifestPath = await confinedCandidate(root, manifest.base, manifest.value);
    if (!manifestPath) continue;
    const buffer = await readBounded(manifestPath, MAX_METADATA_BYTES);
    if (!buffer) continue;
    for (const value of manifestIconPaths(buffer.toString("utf8"))) {
      candidates.push({ base: path.dirname(manifestPath), value });
    }
  }
  for (const value of CONVENTIONAL_ICON_PATHS) candidates.push({ base: root, value });

  for (const candidate of candidates) {
    const resolved = await iconDataUrl(root, candidate.base, candidate.value);
    if (resolved) return resolved;
    if (candidate.value.startsWith("/")) {
      const publicResolved = await iconDataUrl(
        root,
        path.join(root, "public"),
        candidate.value.replace(/^\/+/, ""),
      );
      if (publicResolved) return publicResolved;
    }
  }
  return null;
}

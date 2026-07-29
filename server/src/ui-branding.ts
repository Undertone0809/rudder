const FAVICON_BLOCK_START = "<!-- RUDDER_FAVICON_START -->";
const FAVICON_BLOCK_END = "<!-- RUDDER_FAVICON_END -->";
const RUNTIME_BRANDING_BLOCK_START = "<!-- RUDDER_RUNTIME_BRANDING_START -->";
const RUNTIME_BRANDING_BLOCK_END = "<!-- RUDDER_RUNTIME_BRANDING_END -->";

const DEFAULT_FAVICON_LINKS = [
  '<link rel="icon" href="/favicon.ico" sizes="48x48" />',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />',
  '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />',
].join("\n");

const DEV_FAVICON_LINKS = [
  '<link rel="icon" href="/favicon-dev.ico" sizes="48x48" />',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-dev-32x32.png" />',
  '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-dev-16x16.png" />',
].join("\n");

export type WorktreeUiBranding = {
  enabled: boolean;
  name: string | null;
  color: string | null;
  textColor: string | null;
  faviconHref: string | null;
  faviconLinks: string | null;
};

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeLocalEnvName(value: string | undefined): "dev" | "prod_local" | "e2e" | null {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_") ?? "";
  return normalized === "dev" || normalized === "prod_local" || normalized === "e2e" ? normalized : null;
}

function normalizeHexColor(value: string | undefined): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.split("").map((char) => `${char}${char}`).join("").toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toLowerCase()}`;
  }
  return null;
}

function hslComponentToHex(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, "0");
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  const c = (1 - Math.abs((2 * l) - 1)) * s;
  const h = ((hue % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - (c / 2);

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return `#${hslComponentToHex((r + m) * 255)}${hslComponentToHex((g + m) * 255)}${hslComponentToHex((b + m) * 255)}`;
}

function deriveColorFromSeed(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = ((hash * 33) + char.charCodeAt(0)) >>> 0;
  }
  return hslToHex(hash % 360, 68, 56);
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(color) ?? "#000000";
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function relativeLuminanceChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
  const { r, g, b } = hexToRgb(color);
  return (
    (0.2126 * relativeLuminanceChannel(r)) +
    (0.7152 * relativeLuminanceChannel(g)) +
    (0.0722 * relativeLuminanceChannel(b))
  );
}

function pickReadableTextColor(background: string): string {
  const backgroundLuminance = relativeLuminance(background);
  const whiteContrast = 1.05 / (backgroundLuminance + 0.05);
  const blackContrast = (backgroundLuminance + 0.05) / 0.05;
  return whiteContrast >= blackContrast ? "#f8fafc" : "#111827";
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Keep the official Rudder favicon self-contained because browsers do not reliably
// resolve external image references nested inside a data URL favicon.
const RUDDER_FAVICON_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAEr0lEQVR4nO1XS0ijSRCOMVH/PDyokKhJxPjEiwi6qFkdDIKIMMuOBsWLmMEHIl4UcYedgwePIqIO6EFQFN0RRxQRwYM3QRFk4wt1PIiXWTTiCxJjtJaqpHv/xJ0/2b14mYam/nRXV31dr67IZDIZvPKU/QAAzArB4+npiSaOu7s7mJ+fh5aWFsjPzwedTgfa2FjQ6XVQUFAAra2tsLCwAPf39y/OioekC8TD6/USdbvdMPLpE2RkZHC+iIgIiIqKgpiYGIiOjqbfbC8rKwtGR0fh4eEhQM5/AuD1Hzo+PobS0lLai4yMBI1GQxO/xedoT6sBjfqfvbKyMjg9/foCREgAXj/z5uYmJCcn07pWqwVBEOhboVCA0WiE4uJiqKiogKKiIjAYDLSO+yqVivjx22Qywfb2Nslj7pAE8ORnOjg4gKSkJK4chSuVSqirq4PV1VVwOp3E9/z8TPTy8hJWVlbAZqsBhUJJ/AyE0WQiSzIQIS3gdruhpKSEfsfGxvqEGI2kQKwUqcfjCfiNY2lpicBjXLDzVqsVPJ7H8FwwMDDAb45CUlNTYX9/n/vwT4cDuru7oby8HAoLC4n29PTA7u4u53E4HGR+uVzOLTEyMhIawPX1NUU7HsQIR3+ur6/TQbxtb28vrbNMEFPk7evrg8dH303RVZQpgkA8OTk5lMqSAGZnZ4lipCPt6Ojgt+rs7KQ1TDtUhhMDk33jOu6jNYLPaLU+eV++LEgDsL9/TxQFI4idnR0StLi4yNdZ7osnrmEKqjVqst74+Disra1BfX09tySeb29vlwaQl5dHAvAb04wFVmVlJTezWCmzgrguIHCMDbTe8PAwxYJCqaQ9i8UiDSA+Pp77uLm5mZSfn5+DTq+n1GJKkTKgLN9ra2vp5kdHRxQvWE9sNhvtq9VqoplZWdIABEHgzL99+EAA9vf3uHJWbHCmpaWB3d5I7sE6IE5FHA0NDdxqrIilp6dLA4iLi+PMXV1dvChhNEcqFKBP1EN1dTWMjY3B6enpi7cDawiO3z9+DHAZkxnSArm5uaDw+7O6poaE3d7eUjxkZ2dDVVUVWMusxJeSkgLv3v0KTqfv9mh2HAguOGAZgKLiImkAjY2NvN6bzWa4uLiAiYkJyMzMpOASv3osBqamprgVlpeXA4KUfavUvixoa2uTBjA9PU2U0kqjIZNhhKMyfAtihBjfzTD//bEyMzPDH6+EhAQCjzziNBX8aYj9hCSAq6srCi65PIKnl09hYO4jQASEtf7s7Ay+ffuLzgWnKjM/Wg5diO4M+Rb09/fz1Am+Cc4o0Y3e/vIWXC4XPcnsTDA/y6qhoaHwHiOX2wWWny3fFSgOqsnJSbDb7SGVY3PCgjSsfmBvb4/3A8GC0fz0SprN1B+wiP+ecmxWsDiF3Q94/R3RxsYG6BMT/9UdzP8YjAQqyDpMebLBAFtbW+F3RGwwEIeHh7x+Yyawl08lCBQLaA1UyJTiHkvP0jdv4OTkJEBe2ADEhzDIBgcHeZSziW4Ql2a2hv0ENh+sKga35mEDYCCYAGxWPv/xGZqamqDgpwIChHmPFP8X4OM1NzcHNzc3//9/gex1puwHAHhNK/wNmT/FQCPovQwAAAAASUVORK5CYII=";

function createFaviconDataUrl(background: string): string {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">',
    `<rect width="24" height="24" rx="6" fill="${background}"/>`,
    `<image href="data:image/png;base64,${RUDDER_FAVICON_PNG_BASE64}" x="2" y="2" width="20" height="20" preserveAspectRatio="xMidYMid meet"/>`,
    "</svg>",
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function isWorktreeUiBrandingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.RUDDER_IN_WORKTREE);
}

export function getWorktreeUiBranding(env: NodeJS.ProcessEnv = process.env): WorktreeUiBranding {
  if (!isWorktreeUiBrandingEnabled(env)) {
    const localEnv = normalizeLocalEnvName(env.RUDDER_LOCAL_ENV);
    return {
      enabled: false,
      name: null,
      color: null,
      textColor: null,
      faviconHref: null,
      faviconLinks: localEnv === "dev" ? DEV_FAVICON_LINKS : null,
    };
  }

  const name = nonEmpty(env.RUDDER_WORKTREE_NAME) ?? nonEmpty(env.RUDDER_INSTANCE_ID) ?? "worktree";
  const color = normalizeHexColor(env.RUDDER_WORKTREE_COLOR) ?? deriveColorFromSeed(name);
  const textColor = pickReadableTextColor(color);

  return {
    enabled: true,
    name,
    color,
    textColor,
    faviconHref: createFaviconDataUrl(color),
    faviconLinks: null,
  };
}

export function renderFaviconLinks(branding: WorktreeUiBranding): string {
  if (!branding.enabled && branding.faviconLinks) return branding.faviconLinks;
  if (!branding.enabled || !branding.faviconHref) return DEFAULT_FAVICON_LINKS;

  const href = escapeHtmlAttribute(branding.faviconHref);
  return [
    `<link rel="icon" href="${href}" type="image/svg+xml" sizes="any" />`,
    `<link rel="shortcut icon" href="${href}" type="image/svg+xml" />`,
  ].join("\n");
}

export function renderRuntimeBrandingMeta(branding: WorktreeUiBranding): string {
  if (!branding.enabled || !branding.name || !branding.color || !branding.textColor) return "";

  return [
    '<meta name="rudder-worktree-enabled" content="true" />',
    `<meta name="rudder-worktree-name" content="${escapeHtmlAttribute(branding.name)}" />`,
    `<meta name="rudder-worktree-color" content="${escapeHtmlAttribute(branding.color)}" />`,
    `<meta name="rudder-worktree-text-color" content="${escapeHtmlAttribute(branding.textColor)}" />`,
  ].join("\n");
}

function replaceMarkedBlock(html: string, startMarker: string, endMarker: string, content: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return html;

  const before = html.slice(0, start + startMarker.length);
  const after = html.slice(end);
  const indentedContent = content
    ? `\n${content
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")}\n    `
    : "\n    ";
  return `${before}${indentedContent}${after}`;
}

export function applyUiBranding(html: string, env: NodeJS.ProcessEnv = process.env): string {
  const branding = getWorktreeUiBranding(env);
  const withFavicon = replaceMarkedBlock(html, FAVICON_BLOCK_START, FAVICON_BLOCK_END, renderFaviconLinks(branding));
  return replaceMarkedBlock(
    withFavicon,
    RUNTIME_BRANDING_BLOCK_START,
    RUNTIME_BRANDING_BLOCK_END,
    renderRuntimeBrandingMeta(branding),
  );
}

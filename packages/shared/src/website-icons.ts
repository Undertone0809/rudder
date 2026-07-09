export interface KnownWebsiteIcon {
  hostnames: readonly string[];
  includeSubdomains?: boolean;
  siteName: string;
  iconDataUrl: string;
}

function svgDataUrl(svg: string) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function iconSvg(label: string, background: string, foreground = "#ffffff") {
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<rect width="64" height="64" rx="14" fill="${background}"/>`
    + `<text x="32" y="41" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="700" fill="${foreground}">${label}</text>`
    + `</svg>`,
  );
}

export const KNOWN_WEBSITE_ICONS: readonly KnownWebsiteIcon[] = [
  { hostnames: ["x.com", "twitter.com"], includeSubdomains: true, siteName: "X", iconDataUrl: iconSvg("X", "#111111") },
  { hostnames: ["linkedin.com", "www.linkedin.com"], siteName: "LinkedIn", iconDataUrl: iconSvg("in", "#0A66C2") },
  { hostnames: ["github.com", "www.github.com"], siteName: "GitHub", iconDataUrl: iconSvg("GH", "#24292F") },
  { hostnames: ["youtube.com", "www.youtube.com", "youtu.be"], siteName: "YouTube", iconDataUrl: iconSvg("YT", "#FF0000") },
  { hostnames: ["google.com", "www.google.com"], siteName: "Google", iconDataUrl: iconSvg("G", "#4285F4") },
  { hostnames: ["docs.google.com"], siteName: "Google Docs", iconDataUrl: iconSvg("G", "#34A853") },
  { hostnames: ["notion.so", "www.notion.so"], siteName: "Notion", iconDataUrl: iconSvg("N", "#191919") },
  { hostnames: ["linear.app"], siteName: "Linear", iconDataUrl: iconSvg("L", "#5E6AD2") },
] as const;

const knownWebsiteIconByHostname = new Map(
  KNOWN_WEBSITE_ICONS.flatMap((icon) => icon.hostnames.map((hostname) => [hostname, icon])),
);

export function resolveKnownWebsiteIcon(input: string | URL): KnownWebsiteIcon | null {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return null;
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!hostname) return null;
  const direct = knownWebsiteIconByHostname.get(hostname);
  if (direct) return direct;
  for (const [knownHostname, icon] of knownWebsiteIconByHostname.entries()) {
    if (icon.includeSubdomains && hostname.endsWith(`.${knownHostname}`)) return icon;
  }
  return null;
}

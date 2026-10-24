type TranscriptMcpBrandIcon = {
  aliases: readonly string[];
  label: string;
  src: string;
  imageClassName?: string;
};

const TRANSCRIPT_MCP_BRAND_ICONS: readonly TranscriptMcpBrandIcon[] = [
  {
    aliases: ["rudder", "rudder-tools", "rudder_tools", "rudder-browser", "rudder_browser"],
    label: "Rudder",
    src: "/rudder-logo.png",
  },
  {
    aliases: ["github", "github-tools", "github-mcp", "github-mcp-server"],
    label: "GitHub",
    src: "/brands/github-logo.svg",
    imageClassName: "dark:invert",
  },
  {
    aliases: ["gmail"],
    label: "Gmail",
    src: "/brands/gmail-logo.svg",
  },
  {
    aliases: ["google-calendar", "google_calendar"],
    label: "Google Calendar",
    src: "/brands/google-calendar-logo.svg",
  },
  {
    aliases: ["google-drive", "google_drive"],
    label: "Google Drive",
    src: "/brands/google-drive-logo.svg",
  },
  {
    aliases: ["notion"],
    label: "Notion",
    src: "/brands/notion-logo.svg",
    imageClassName: "dark:invert",
  },
  {
    aliases: ["linear"],
    label: "Linear",
    src: "/brands/linear-logo.svg",
  },
];

export function getTranscriptMcpBrandIcon(server: string | null | undefined): TranscriptMcpBrandIcon | null {
  const normalizedServer = server?.trim().toLowerCase();
  if (!normalizedServer) return null;
  return TRANSCRIPT_MCP_BRAND_ICONS.find((brand) => brand.aliases.includes(normalizedServer)) ?? null;
}

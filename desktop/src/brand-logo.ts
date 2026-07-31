import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const OFFICIAL_RUDDER_LOGO_SHA256 =
  "9f44fb2408a53587acf1f7ad769abb8671d74a81475dae68f4a2056dce4e13fe";

export function resolveOfficialRudderLogoDataUrl(options: {
  isPackaged: boolean;
  moduleDir: string;
  resourcesPath: string;
}): string | null {
  const candidates = options.isPackaged
    ? [
        path.resolve(options.resourcesPath, "rudder-logo.png"),
        path.resolve(options.resourcesPath, "server-package", "ui-dist", "rudder-logo.png"),
      ]
    : [
        path.resolve(options.moduleDir, "../../ui/public/rudder-logo.png"),
        path.resolve(options.moduleDir, "../../server/ui-dist/rudder-logo.png"),
      ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const bytes = fs.readFileSync(candidate);
    if (createHash("sha256").update(bytes).digest("hex") !== OFFICIAL_RUDDER_LOGO_SHA256) continue;
    return `data:image/png;base64,${bytes.toString("base64")}`;
  }
  return null;
}

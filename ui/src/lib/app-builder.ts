const APP_BUILDER_SLUG_MAX_LENGTH = 63;

export const APP_BUILDER_SCAFFOLD_VERSION = "1";

export function appBuilderSlug(appName: string, appId: string): string {
  const identitySuffix = appId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)
    || "app";
  const normalized = appName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, APP_BUILDER_SLUG_MAX_LENGTH - identitySuffix.length - 1)
    .replace(/-+$/g, "");
  if (normalized) return `${normalized}-${identitySuffix}`;
  return `app-${identitySuffix}`;
}

export function appBuilderSourceRoot(appName: string, appId: string): string {
  return `apps/${appBuilderSlug(appName, appId)}`;
}

export function appBuilderChatPrefill(
  appName: string,
  existingApp: boolean,
  sourceRoot?: string,
  appId?: string,
): string {
  if (existingApp) {
    return [
      `Use $app-builder to continue building “${appName}”.`,
      "Inspect the current App and its data mode, implement the requested change, run the maintained checks, and verify the real rendered workflow.",
    ].join(" ");
  }
  return [
    `Use $app-builder to build an App named “${appName}”${sourceRoot ? ` at ${sourceRoot}` : ""}.`,
    appId
      ? `Rudder App handoff: appId=${appId}; sourceRoot=${sourceRoot}.`
      : null,
    "Use Rudder's maintained full-stack scaffold, ask only business/data questions that materially affect the result, then build and verify the App.",
  ].filter(Boolean).join(" ");
}

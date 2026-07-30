import type { DesktopLocalAppDefinition } from "@/lib/desktop-shell";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import type { AppBuilderApp } from "@rudderhq/shared";

export type ManagedAppEntry = {
  kind: "managed";
  key: string;
  app: AppBuilderApp;
  definition: DesktopLocalAppDefinition | null;
};

export type LocalAppEntry = {
  kind: "local";
  key: string;
  definition: DesktopLocalAppDefinition;
};

export type AppEntry = ManagedAppEntry | LocalAppEntry;

export function appRoute(key: string) {
  return `/apps/view/${encodeURIComponent(key)}`;
}

export function localBindingKey(
  desktopInstallationId: string,
  appPublicId: string,
  localBindingId: string,
) {
  return `${desktopInstallationId}:${appPublicId}:${localBindingId}`;
}

export function activeKeyFromPath(pathname: string) {
  const relativePath = toOrganizationRelativePath(pathname);
  const match = relativePath.match(/^\/apps\/view\/([^/]+)$/);
  if (!match?.[1]) return "home";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "home";
  }
}

export function appBuildStatusLabel(status: AppBuilderApp["buildStatus"]) {
  if (status === "preparing") return "Preparing";
  if (status === "building") return "Building";
  if (status === "verifying") return "Verifying";
  if (status === "ready") return "Ready";
  return "Needs attention";
}

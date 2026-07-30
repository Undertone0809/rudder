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

let appDirectOpenVersion = 0;
const appDirectOpenIntents = new Map<string, {
  createdAt: number;
  version: number;
}>();
const appDirectOpenListeners = new Set<() => void>();
const APP_DIRECT_OPEN_TTL_MS = 10_000;

function appDirectOpenScope(organizationId: string, key: string) {
  return `${organizationId}:${key}`;
}

export function requestAppDirectOpen(organizationId: string, key: string) {
  appDirectOpenVersion += 1;
  appDirectOpenIntents.set(appDirectOpenScope(organizationId, key), {
    createdAt: Date.now(),
    version: appDirectOpenVersion,
  });
  appDirectOpenListeners.forEach((listener) => listener());
}

export function readAppDirectOpenIntent(organizationId: string, key: string) {
  const scope = appDirectOpenScope(organizationId, key);
  const intent = appDirectOpenIntents.get(scope);
  if (!intent) return 0;
  if (Date.now() - intent.createdAt <= APP_DIRECT_OPEN_TTL_MS) {
    return intent.version;
  }
  appDirectOpenIntents.delete(scope);
  return 0;
}

export function acknowledgeAppDirectOpen(
  organizationId: string,
  key: string,
  version: number,
) {
  const scope = appDirectOpenScope(organizationId, key);
  if (appDirectOpenIntents.get(scope)?.version !== version) return;
  appDirectOpenIntents.delete(scope);
  appDirectOpenListeners.forEach((listener) => listener());
}

export function subscribeAppDirectOpen(listener: () => void) {
  appDirectOpenListeners.add(listener);
  return () => appDirectOpenListeners.delete(listener);
}

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

import type { Location } from "react-router-dom";
import { toOrganizationRelativePath } from "./organization-routes";

const SETTINGS_OVERLAY_BACKGROUND_PATH_KEY = "settingsOverlayBackgroundPath";
const SETTINGS_OVERLAY_STORAGE_KEY = "rudder.settingsOverlayBackgroundPath";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isSettingsOverlayRoutePath(path: string): boolean {
  const relativePath = toOrganizationRelativePath(path);
  return relativePath.startsWith("/instance/settings")
    || relativePath.startsWith("/organization/settings");
}

export function readSettingsOverlayBackgroundPath(state: unknown): string | null {
  const record = asRecord(state);
  const raw = record?.[SETTINGS_OVERLAY_BACKGROUND_PATH_KEY];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function buildSettingsOverlayState(
  location: Pick<Location, "pathname" | "search" | "hash" | "state">,
): Record<string, unknown> | undefined {
  const existingBackgroundPath = readSettingsOverlayBackgroundPath(location.state);
  if (existingBackgroundPath) {
    return asRecord(location.state) ?? {
      [SETTINGS_OVERLAY_BACKGROUND_PATH_KEY]: existingBackgroundPath,
    };
  }

  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  if (isSettingsOverlayRoutePath(currentPath)) return undefined;

  const nextState = {
    ...(asRecord(location.state) ?? {}),
    [SETTINGS_OVERLAY_BACKGROUND_PATH_KEY]: currentPath,
  };
  return nextState;
}

export function preserveSettingsOverlayState(state: unknown): Record<string, unknown> | undefined {
  const backgroundPath = readSettingsOverlayBackgroundPath(state);
  if (!backgroundPath) return undefined;
  return asRecord(state) ?? {
    [SETTINGS_OVERLAY_BACKGROUND_PATH_KEY]: backgroundPath,
  };
}

export function rememberSettingsOverlayBackgroundPath(path: string): void {
  if (typeof window === "undefined" || isSettingsOverlayRoutePath(path)) return;
  try {
    window.sessionStorage.setItem(SETTINGS_OVERLAY_STORAGE_KEY, path);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

export function readStoredSettingsOverlayBackgroundPath(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(SETTINGS_OVERLAY_STORAGE_KEY);
    return value && !isSettingsOverlayRoutePath(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearStoredSettingsOverlayBackgroundPath(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_OVERLAY_STORAGE_KEY);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

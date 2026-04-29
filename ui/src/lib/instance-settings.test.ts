import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_PATH,
  INSTANCE_SETTINGS_ABOUT_PATH,
  DEFAULT_INSTANCE_SETTINGS_PATH,
  INSTANCE_SETTINGS_LANGFUSE_PATH,
  INSTANCE_SETTINGS_NOTIFICATIONS_PATH,
  INSTANCE_SETTINGS_ORGANIZATIONS_PATH,
  INSTANCE_SETTINGS_PROFILE_PATH,
  normalizeRememberedSettingsPath,
  normalizeRememberedInstanceSettingsPath,
  resolveDefaultSettingsPath,
  resolveDefaultInstanceSettingsPath,
} from "./instance-settings";

describe("normalizeRememberedInstanceSettingsPath", () => {
  it("keeps known instance settings pages", () => {
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/profile", false)).toBe(
      "/instance/settings/profile",
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/general")).toBe(
      "/instance/settings/general",
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/notifications")).toBe(
      INSTANCE_SETTINGS_NOTIFICATIONS_PATH,
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/organizations")).toBe(
      INSTANCE_SETTINGS_ORGANIZATIONS_PATH,
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/langfuse")).toBe(
      INSTANCE_SETTINGS_LANGFUSE_PATH,
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/about")).toBe(
      INSTANCE_SETTINGS_ABOUT_PATH,
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/plugins/example?tab=config#logs")).toBe(
      "/instance/settings/plugins/example?tab=config#logs",
    );
  });

  it("falls back to the default page for unknown paths", () => {
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/nope")).toBe(
      DEFAULT_INSTANCE_SETTINGS_PATH,
    );
    expect(normalizeRememberedInstanceSettingsPath(null)).toBe(DEFAULT_INSTANCE_SETTINGS_PATH);
  });

  it("falls back to profile for non-admin users when a remembered path is admin-only", () => {
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/general", false)).toBe(
      INSTANCE_SETTINGS_PROFILE_PATH,
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/notifications", false)).toBe(
      INSTANCE_SETTINGS_PROFILE_PATH,
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/organizations", false)).toBe(
      INSTANCE_SETTINGS_PROFILE_PATH,
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/plugins/example", false)).toBe(
      INSTANCE_SETTINGS_PROFILE_PATH,
    );
  });
});

describe("resolveDefaultInstanceSettingsPath", () => {
  it("returns the correct default path for admin access", () => {
    expect(resolveDefaultInstanceSettingsPath(true)).toBe(DEFAULT_INSTANCE_SETTINGS_PATH);
    expect(resolveDefaultInstanceSettingsPath(false)).toBe(INSTANCE_SETTINGS_PROFILE_PATH);
  });
});

describe("normalizeRememberedSettingsPath", () => {
  it("keeps known organization and system settings pages", () => {
    expect(normalizeRememberedSettingsPath("/organization/settings")).toBe("/organization/settings");
    expect(normalizeRememberedSettingsPath("/org")).toBe("/org");
    expect(normalizeRememberedSettingsPath("/instance/settings/general")).toBe("/instance/settings/general");
    expect(normalizeRememberedSettingsPath("/instance/settings/notifications")).toBe(
      INSTANCE_SETTINGS_NOTIFICATIONS_PATH,
    );
    expect(normalizeRememberedSettingsPath("/instance/settings/organizations")).toBe(
      INSTANCE_SETTINGS_ORGANIZATIONS_PATH,
    );
    expect(normalizeRememberedSettingsPath("/instance/settings/langfuse")).toBe(INSTANCE_SETTINGS_LANGFUSE_PATH);
    expect(normalizeRememberedSettingsPath("/instance/settings/about")).toBe(INSTANCE_SETTINGS_ABOUT_PATH);
    expect(normalizeRememberedSettingsPath("/instance/settings/plugins/example?tab=config#logs")).toBe(
      "/instance/settings/plugins/example?tab=config#logs",
    );
  });

  it("defaults to organization settings for unknown paths", () => {
    expect(normalizeRememberedSettingsPath("/instance/settings/nope")).toBe(DEFAULT_SETTINGS_PATH);
    expect(normalizeRememberedSettingsPath(null)).toBe(DEFAULT_SETTINGS_PATH);
  });

  it("falls back to profile for non-admin users when the remembered page is admin-only", () => {
    expect(normalizeRememberedSettingsPath("/instance/settings/general", false)).toBe(
      INSTANCE_SETTINGS_PROFILE_PATH,
    );
    expect(normalizeRememberedSettingsPath("/instance/settings/notifications", false)).toBe(
      INSTANCE_SETTINGS_PROFILE_PATH,
    );
    expect(normalizeRememberedSettingsPath("/instance/settings/organizations", false)).toBe(
      INSTANCE_SETTINGS_PROFILE_PATH,
    );
  });
});

describe("resolveDefaultSettingsPath", () => {
  it("always opens the unified settings entry point", () => {
    expect(resolveDefaultSettingsPath(true)).toBe(DEFAULT_SETTINGS_PATH);
    expect(resolveDefaultSettingsPath(false)).toBe(DEFAULT_SETTINGS_PATH);
  });
});

import { describe, expect, it } from "vitest";
import { instanceSettingsService, normalizeInstanceLocale } from "../services/instance-settings.js";

type TestInstanceSettingsRow = {
  id: string;
  singletonKey: string;
  general: Record<string, unknown>;
  notifications: Record<string, unknown>;
  browser?: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function createInstanceSettingsDb(initialBrowser: unknown, initialGeneral: Record<string, unknown> = {}) {
  let row: TestInstanceSettingsRow = {
    id: "instance-settings-1",
    singletonKey: "default",
    general: initialGeneral,
    notifications: {},
    browser: initialBrowser,
    createdAt: new Date("2026-07-12T00:00:00.000Z"),
    updatedAt: new Date("2026-07-12T00:00:00.000Z"),
  };

  const db = {
    select: () => ({
      from: () => ({
        where: async () => [row],
      }),
    }),
    update: () => ({
      set: (patch: Partial<TestInstanceSettingsRow>) => ({
        where: () => ({
          returning: async () => {
            row = { ...row, ...patch };
            return [row];
          },
        }),
      }),
    }),
  };

  return {
    db: db as any,
    readRow: () => row,
  };
}

describe("normalizeInstanceLocale", () => {
  it("defaults missing values to en", () => {
    expect(normalizeInstanceLocale(undefined)).toBe("en");
  });

  it("keeps supported locales", () => {
    expect(normalizeInstanceLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeInstanceLocale("en")).toBe("en");
  });

  it("coerces unsupported values back to en", () => {
    expect(normalizeInstanceLocale("fr")).toBe("en");
  });
});

describe("instanceSettingsService Browser settings", () => {
  it("defaults missing Browser JSON safely", async () => {
    const { db } = createInstanceSettingsDb(undefined);
    const service = instanceSettingsService(db);

    expect(service.getBrowser).toBeTypeOf("function");
    expect(await service.getBrowser()).toEqual({
      enabled: true,
      openLinksIn: "built_in",
    });
    await expect(service.get()).resolves.toMatchObject({
      browser: {
        enabled: true,
        openLinksIn: "built_in",
      },
    });
  });

  it("fills legacy partial Browser JSON with defaults", async () => {
    const { db } = createInstanceSettingsDb({ enabled: false });
    const service = instanceSettingsService(db);

    expect(service.getBrowser).toBeTypeOf("function");
    await expect(service.getBrowser()).resolves.toEqual({
      enabled: false,
      openLinksIn: "built_in",
    });
  });

  it("replaces invalid Browser JSON with safe defaults", async () => {
    const { db } = createInstanceSettingsDb({
      enabled: "yes",
      openLinksIn: "unsafe_browser",
    });
    const service = instanceSettingsService(db);

    expect(service.getBrowser).toBeTypeOf("function");
    await expect(service.getBrowser()).resolves.toEqual({
      enabled: true,
      openLinksIn: "built_in",
    });
  });

  it("persists Browser patches and returns them from full instance settings", async () => {
    const { db, readRow } = createInstanceSettingsDb({});
    const service = instanceSettingsService(db);

    expect(service.updateBrowser).toBeTypeOf("function");
    const updated = await service.updateBrowser({
      enabled: false,
      openLinksIn: "default_browser",
    });

    expect(updated).toMatchObject({
      browser: {
        enabled: false,
        openLinksIn: "default_browser",
      },
    });
    expect(readRow().browser).toEqual({
      enabled: false,
      openLinksIn: "default_browser",
    });
    await expect(service.get()).resolves.toMatchObject({
      browser: {
        enabled: false,
        openLinksIn: "default_browser",
      },
    });
  });
});

describe("instanceSettingsService general settings", () => {
  it("defaults experimental plugins and sites to disabled", async () => {
    const service = instanceSettingsService(createInstanceSettingsDb(undefined).db);

    await expect(service.getGeneral()).resolves.toMatchObject({
      experimentalPluginsEnabled: false,
      experimentalSitesEnabled: false,
    });
  });

  it("preserves the explicit plugin flag and mirrors the legacy sites flag", async () => {
    const enabledService = instanceSettingsService(
      createInstanceSettingsDb(undefined, { experimentalPluginsEnabled: true }).db,
    );
    const disabledService = instanceSettingsService(
      createInstanceSettingsDb(undefined, { experimentalPluginsEnabled: false }).db,
    );

    await expect(enabledService.getGeneral()).resolves.toMatchObject({
      experimentalPluginsEnabled: true,
      experimentalSitesEnabled: true,
    });
    await expect(disabledService.getGeneral()).resolves.toMatchObject({
      experimentalPluginsEnabled: false,
      experimentalSitesEnabled: false,
    });
  });
});

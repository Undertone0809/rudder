import { describe, expect, it } from "vitest";
import {
  OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH,
  instanceBrowserSettingsSchema,
  instanceGeneralSettingsSchema,
  keyboardShortcutSettingsSchema,
  operatorProfileSettingsSchema,
  patchInstanceBrowserSettingsSchema,
} from "./instance.js";

describe("instanceBrowserSettingsSchema", () => {
  it("defaults Browser on and opens links in the built-in Browser", () => {
    expect(instanceBrowserSettingsSchema.parse({})).toEqual({
      enabled: true,
      openLinksIn: "built_in",
    });
  });

  it("accepts supported Browser settings", () => {
    expect(instanceBrowserSettingsSchema.parse({
      enabled: false,
      openLinksIn: "default_browser",
    })).toEqual({
      enabled: false,
      openLinksIn: "default_browser",
    });
  });

  it("rejects invalid and unknown Browser settings", () => {
    expect(instanceBrowserSettingsSchema).toBeDefined();
    expect(() => instanceBrowserSettingsSchema.parse({ openLinksIn: "external" })).toThrow();
    expect(() => instanceBrowserSettingsSchema.parse({ enabled: true, cookie: "secret" })).toThrow();
  });
});

describe("patchInstanceBrowserSettingsSchema", () => {
  it("accepts a partial Browser settings patch", () => {
    expect(patchInstanceBrowserSettingsSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it("rejects unknown Browser settings patch fields", () => {
    expect(patchInstanceBrowserSettingsSchema).toBeDefined();
    expect(() => patchInstanceBrowserSettingsSchema.parse({ profilePath: "/tmp/profile" })).toThrow();
  });
});

describe("instanceGeneralSettingsSchema", () => {
  it("defaults developer diagnostics off", () => {
    expect(instanceGeneralSettingsSchema.parse({})).toEqual({
      censorUsernameInLogs: false,
      showDeveloperDiagnostics: false,
      experimentalSitesEnabled: false,
      locale: "en",
    });
  });
});

describe("operatorProfileSettingsSchema", () => {
  it("accepts imported profile context up to the shared limit", () => {
    const value = "x".repeat(OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH);

    expect(operatorProfileSettingsSchema.parse({ moreAboutYou: value })).toEqual({
      nickname: "",
      moreAboutYou: value,
    });
  });

  it("rejects imported profile context above the shared limit", () => {
    const value = "x".repeat(OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH + 1);

    expect(() => operatorProfileSettingsSchema.parse({ moreAboutYou: value })).toThrow();
  });
});

describe("keyboardShortcutSettingsSchema", () => {
  it("accepts shortcut preferences with bindings and disabled actions", () => {
    expect(
      keyboardShortcutSettingsSchema.parse({
        shortcuts: [
          {
            actionId: "issue.create",
            bindings: [{ key: "i", metaKey: true }],
          },
          {
            actionId: "commandPalette.open",
            disabled: true,
          },
        ],
      }),
    ).toEqual({
      shortcuts: [
        {
          actionId: "issue.create",
          bindings: [{ key: "i", metaKey: true }],
        },
        {
          actionId: "commandPalette.open",
          disabled: true,
        },
      ],
    });
  });

  it("rejects unknown action ids", () => {
    expect(() =>
      keyboardShortcutSettingsSchema.parse({
        shortcuts: [{ actionId: "system.escapeBack", disabled: true }],
      }),
    ).toThrow();
  });

  it("rejects duplicate action ids and invalid binding shape", () => {
    expect(() =>
      keyboardShortcutSettingsSchema.parse({
        shortcuts: [
          { actionId: "issue.create", bindings: [{ key: "i" }] },
          { actionId: "issue.create", bindings: [{ key: "" }] },
        ],
      }),
    ).toThrow();
  });
});

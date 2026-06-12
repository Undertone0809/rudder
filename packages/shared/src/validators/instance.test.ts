import { describe, expect, it } from "vitest";
import {
  OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH,
  keyboardShortcutSettingsSchema,
  instanceGeneralSettingsSchema,
  operatorProfileSettingsSchema,
} from "./instance.js";

describe("instanceGeneralSettingsSchema", () => {
  it("defaults developer diagnostics off", () => {
    expect(instanceGeneralSettingsSchema.parse({})).toEqual({
      censorUsernameInLogs: false,
      showDeveloperDiagnostics: false,
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

import { describe, expect, it } from "vitest";
import { normalizeInstanceLocale } from "../services/instance-settings.js";

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

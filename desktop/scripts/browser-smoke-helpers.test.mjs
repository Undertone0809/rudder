import { describe, expect, it } from "vitest";
import { classifyGoogleSmokeNavigation } from "./browser-smoke-helpers.mjs";

describe("Google Browser smoke navigation", () => {
  it.each([
    ["https://www.google.com/search?q=google", "search"],
    ["https://www.google.com/search?q=google&sourceid=chrome", "search"],
    ["https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dgoogle", "captcha"],
  ])("classifies %s as %s", (url, expected) => {
    expect(classifyGoogleSmokeNavigation(url)).toBe(expected);
  });

  it.each([
    "https://www.google.com/url?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dgoogle",
    "https://www.google.com/search?q=other",
    "https://www.google.com/sorry/index",
    "https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dother",
    "https://www.google.com/sorry/index?continue=https%3A%2F%2Fexample.com%2F",
    "https://example.com/search?q=google",
  ])("rejects an ambiguous Google navigation URL: %s", (url) => {
    expect(classifyGoogleSmokeNavigation(url)).toBeNull();
  });
});

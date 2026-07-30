import { describe, expect, it } from "vitest";
import {
  appBuilderChatPrefill,
  appBuilderSlug,
  appBuilderSourceRoot,
} from "./app-builder";

describe("App Builder UI helpers", () => {
  it("derives a safe unique app root", () => {
    expect(appBuilderSlug("Cold Email CRM!", "project-id")).toBe("cold-email-crm-projecti");
    expect(appBuilderSourceRoot("Cold Email CRM!", "project-id"))
      .toBe("apps/cold-email-crm-projecti");
  });

  it("uses a stable fallback for a non-latin App name", () => {
    expect(appBuilderSlug("营销数据", "62a5b73f-910b-4a29-a123")).toBe("app-62a5b73f");
  });

  it("keeps the App Builder skill explicit in Chat handoff", () => {
    expect(appBuilderChatPrefill("CRM", false)).toContain("$app-builder");
    expect(appBuilderChatPrefill("CRM", true)).toContain("continue building");
  });
});

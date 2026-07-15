import { describe, expect, it } from "vitest";
import {
  createDesktopSupportMailtoUrl,
  DESKTOP_BUG_REPORT_URL,
  DESKTOP_FEEDBACK_EMAIL,
  MAX_DESKTOP_SUPPORT_MAILTO_LENGTH,
} from "./desktop-support-mail.js";

describe("desktop support mail", () => {
  it("keeps generic feedback compatible with the About page", () => {
    expect(createDesktopSupportMailtoUrl({
      version: "0.4.6",
      platform: "darwin",
      arch: "arm64",
    })).toBe(`mailto:${DESKTOP_FEEDBACK_EMAIL}?subject=Rudder+feedback+%280.4.6%29`);
  });

  it("builds a bounded startup draft from the safe failure view", () => {
    const url = createDesktopSupportMailtoUrl({
      version: "0.4.6\r\nBcc: attacker@example.com",
      platform: "darwin",
      arch: "arm64",
      profile: "prod_local&attach=/tmp/private",
      instance: "default",
      failure: {
        id: "failure-123",
        occurredAt: "2026-07-15T10:00:00.000Z",
        stage: "database",
        attempt: 2,
        category: "migration",
        summary: "The local database could not finish its migration.",
      },
    });
    const parsed = new URL(url);
    const body = parsed.searchParams.get("body") ?? "";

    expect(parsed.protocol).toBe("mailto:");
    expect(parsed.pathname).toBe(DESKTOP_FEEDBACK_EMAIL);
    expect(parsed.searchParams.get("subject")).toContain("Rudder startup support");
    expect(parsed.searchParams.has("bcc")).toBe(false);
    expect(parsed.searchParams.has("cc")).toBe(false);
    expect(parsed.searchParams.has("attach")).toBe(false);
    expect(body).toContain("Failure ID: failure-123");
    expect(body).toContain("Summary: [What broke, and which workflow is blocked?]");
    expect(body).toContain("Steps to reproduce:");
    expect(body).toContain("Actual result:");
    expect(body).toContain("Expected result:");
    expect(body).toContain("Did Try again change the result?");
    expect(body).toContain("Impact and workaround:");
    expect(body).toContain("Environment details:");
    expect(body).toContain("Safe diagnostic summary (added by Rudder)");
    expect(body).toContain("Do not attach .env");
    expect(url.length).toBeLessThanOrEqual(MAX_DESKTOP_SUPPORT_MAILTO_LENGTH);
  });

  it("keeps the bug report destination fixed to the repository template", () => {
    const parsed = new URL(DESKTOP_BUG_REPORT_URL);

    expect(parsed.origin).toBe("https://github.com");
    expect(parsed.pathname).toBe("/Undertone0809/rudder/issues/new");
    expect(parsed.searchParams.get("template")).toBe("bug_report.yml");
  });

  it("bounds all renderer-adjacent metadata before encoding", () => {
    const url = createDesktopSupportMailtoUrl({
      version: "v".repeat(4_000),
      platform: "p".repeat(4_000),
      arch: "a".repeat(4_000),
      profile: "x".repeat(4_000),
      instance: "y".repeat(4_000),
      failure: {
        id: "failure-789",
        occurredAt: "2026-07-15T10:00:00.000Z",
        stage: "database",
        attempt: 1,
        category: "database",
        summary: "The local database did not start cleanly.",
      },
    });

    expect(url.length).toBeLessThanOrEqual(MAX_DESKTOP_SUPPORT_MAILTO_LENGTH);
  });
});

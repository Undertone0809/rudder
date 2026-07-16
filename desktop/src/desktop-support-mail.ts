import type { DesktopStartupFailureView } from "./desktop-startup-failure.js";

export const DESKTOP_FEEDBACK_EMAIL = "zeeland4work@gmail.com";
export const DESKTOP_BUG_REPORT_URL = "https://github.com/Undertone0809/rudder/issues/new?template=bug_report.yml";
export const MAX_DESKTOP_SUPPORT_MAILTO_LENGTH = 1_900;
export const MAX_DESKTOP_BUG_REPORT_URL_LENGTH = 7_500;

type DesktopSupportInput = {
  version: string;
  platform: string;
  arch: string;
  failure?: DesktopStartupFailureView | null;
  profile?: string | null;
  instance?: string | null;
  context?: "startup" | "rollback";
  failedVersion?: string | null;
  restoredVersion?: string | null;
};

function cleanMailField(value: string | null | undefined, maxLength: number): string | null {
  const cleaned = value
    ?.replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

function createMailto(subject: string, body?: string): string {
  const params = [`subject=${encodeURIComponent(subject)}`];
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  const url = `mailto:${DESKTOP_FEEDBACK_EMAIL}?${params.join("&")}`;
  if (url.length > MAX_DESKTOP_SUPPORT_MAILTO_LENGTH) {
    throw new Error("The support email draft exceeds the safe mailto length.");
  }
  return url;
}

function createSupportBody(input: DesktopSupportInput): string | null {
  const version = cleanMailField(input.version, 80) ?? "unknown";
  if (!input.failure) return null;

  const failure = input.failure;
  const profile = cleanMailField(input.profile, 80) ?? "unknown";
  const instance = cleanMailField(input.instance, 80) ?? "unknown";
  const platform = cleanMailField(input.platform, 40) ?? "unknown";
  const arch = cleanMailField(input.arch, 40) ?? "unknown";
  const rollback = input.context === "rollback";
  return [
    "Hi,",
    "",
    rollback
      ? "Rudder restored the last working version after an update failed to start. Please add the context below before sending."
      : "Rudder could not start. Please add the context below before sending.",
    "",
    "What were you trying to do? [Add context]",
    "What changed before this started? [Update, install, configuration, or system change]",
    "Did Try again change the result? [Yes/no]",
    "Impact or workaround: [Add context]",
    "Evidence: [Optional screenshot or relevant log lines after review]",
    "",
    "Safe diagnostic (added by Rudder)",
    `Failure ID: ${failure.id}`,
    `Occurred at: ${failure.occurredAt}`,
    `Rudder version: ${version}`,
    `System: ${platform} / ${arch}`,
    `Stage: ${failure.stage}`,
    `Attempt: ${failure.attempt}`,
    `Category: ${failure.category}`,
    `Failure summary: ${failure.summary}`,
    ...(rollback
      ? [
          `Failed update: ${cleanMailField(input.failedVersion, 80) ?? "unknown"}`,
          `Restored version: ${cleanMailField(input.restoredVersion, 80) ?? version}`,
        ]
      : []),
    `Profile: ${profile}`,
    `Instance: ${instance}`,
    "",
    "Review before sending. Remove secrets, private URLs, prompts, command output, and private paths. Do not attach .env, config.json, databases, credentials, or private workspace files.",
  ].join("\n");
}

export function createDesktopSupportMailtoUrl(input: DesktopSupportInput): string {
  const version = cleanMailField(input.version, 80) ?? "unknown";
  const body = createSupportBody(input);
  if (!body) return createMailto(`Rudder feedback (${version})`);

  const subject = input.context === "rollback"
    ? `Rudder update rollback support (${cleanMailField(input.failedVersion, 80) ?? version})`
    : `Rudder startup support (${version})`;
  return createMailto(subject, body);
}

export function createDesktopBugReportUrl(input: DesktopSupportInput): string {
  if (!input.failure) return DESKTOP_BUG_REPORT_URL;
  const version = cleanMailField(input.version, 80) ?? "unknown";
  const failedVersion = cleanMailField(input.failedVersion, 80) ?? version;
  const title = input.context === "rollback"
    ? `Desktop update ${failedVersion} failed and rolled back`
    : `Desktop startup failed on ${version}`;
  const body = createSupportBody(input) ?? "";
  const url = `https://github.com/Undertone0809/rudder/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=bug%2Cdesktop`;
  if (url.length > MAX_DESKTOP_BUG_REPORT_URL_LENGTH) {
    throw new Error("The Desktop bug report draft exceeds the safe URL length.");
  }
  return url;
}

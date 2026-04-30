export type RudderAppVersionParts = {
  serverRuntimeVersion?: string | null;
  bootRuntimeVersion?: string | null;
  desktopAppVersion?: string | null;
};

export function resolveRudderAppVersion(parts: RudderAppVersionParts): string {
  return parts.serverRuntimeVersion
    ?? parts.bootRuntimeVersion
    ?? parts.desktopAppVersion
    ?? "0.0.0";
}

export function createVersionedFeedbackMailtoUrl(input: {
  email: string;
  version: string;
}): string {
  const params = new URLSearchParams({
    subject: `Rudder feedback (${input.version})`,
  });
  return `mailto:${input.email}?${params.toString()}`;
}

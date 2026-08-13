/**
 * Public keys shipped with the signed Desktop update verifier. Private signing
 * material never belongs in this repository or in the Desktop bundle.
 *
 * The key is intentionally represented as DER base64 so electron-builder does
 * not need to package a mutable PEM file beside the app executable.
 */
export const DESKTOP_UPDATE_TRUST_KEYS: Readonly<Record<string, Buffer>> = {
  "rudder-desktop-2026": Buffer.from(
    "MCowBQYDK2VwAyEA7z7DTtDDOs2VltdPPE53sUpVkulPr0FbgVpGA44b4nw=",
    "base64",
  ),
};

/**
 * Packaged smoke runs use a locally generated key so the public lifecycle can
 * exercise the same verifier and cache path without depending on the network.
 * The override is deliberately gated by the smoke application identity and a
 * dedicated environment variable; production installs retain the shipped key.
 */
export function resolveDesktopUpdateTrustKeys(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string | Buffer>> {
  const smokeKey = env.RUDDER_DESKTOP_SMOKE_POLICY_PUBLIC_KEY?.trim();
  if (env.RUDDER_DESKTOP_APP_NAME?.startsWith("Rudder-smoke-") && smokeKey) {
    return { "rudder-desktop-smoke": Buffer.from(smokeKey, "base64") };
  }
  return DESKTOP_UPDATE_TRUST_KEYS;
}

export const DESKTOP_UPDATE_POLICY_URL =
  "https://updates.rudderhq.dev/desktop/policy.json";

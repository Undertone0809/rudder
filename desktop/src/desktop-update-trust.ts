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

export const DESKTOP_UPDATE_POLICY_URL =
  "https://updates.rudderhq.dev/desktop/policy.json";

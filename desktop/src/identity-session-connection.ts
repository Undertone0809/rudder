import type { IdentityDeviceCredential } from "./identity-credential-vault.js";
import type { DesktopOfflineGrantCredential } from "./identity-offline-grant.js";

type IdentityError = {
  code?: unknown;
};

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && (error as IdentityError).code === code;
}

export function selectMatchingDesktopOfflineGrant(
  offlineGrant: DesktopOfflineGrantCredential | null,
  identityCredential: Pick<IdentityDeviceCredential, "issuer" | "accountId" | "deviceId"> | null,
  expectedIssuer: string,
): DesktopOfflineGrantCredential | null {
  if (!offlineGrant || !identityCredential) return null;
  if (
    offlineGrant.issuer !== expectedIssuer
    || identityCredential.issuer !== expectedIssuer
    || offlineGrant.accountId !== identityCredential.accountId
    || offlineGrant.deviceId !== identityCredential.deviceId
  ) return null;
  return offlineGrant;
}

export async function connectDesktopLocalAccountSession(options: {
  credential: DesktopOfflineGrantCredential | null;
  createServerExchange(): Promise<string>;
  establishOnline(exchangeCode: string): Promise<void>;
  establishOffline(credential: DesktopOfflineGrantCredential): Promise<void>;
  retryDelayMs?: number;
  sleep?(delayMs: number): Promise<void>;
}): Promise<void> {
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  }));
  let exchangeCode: string | null = null;
  let onlineError: unknown;

  try {
    exchangeCode = await options.createServerExchange();
  } catch (error) {
    onlineError = error;
    if (hasCode(error, "IDENTITY_SESSION_REJECTED")) throw error;

    // A clean install or an expired Offline Grant still needs one bounded
    // online retry before the startup screen reports a failure. This is
    // especially important on Windows where the first network request can
    // race the desktop shell coming online.
    if (!options.credential) {
      if (!hasCode(error, "IDENTITY_UNAVAILABLE")) throw error;
      await sleep(options.retryDelayMs ?? 250);
      exchangeCode = await options.createServerExchange();
    }
  }

  if (exchangeCode) {
    await options.establishOnline(exchangeCode);
    return;
  }

  if (!options.credential) throw onlineError ?? new Error("Rudder Account exchange did not return a code");

  try {
    await options.establishOffline(options.credential);
  } catch (offlineError) {
    // The grant may belong to a previous Windows installation/account, or the
    // first cloud request may have failed transiently. Re-run the online
    // exchange once so a rejected Offline Grant never strands startup until a
    // user manually restarts the Local Runtime.
    await sleep(options.retryDelayMs ?? 250);
    const retryExchangeCode = await options.createServerExchange();
    try {
      await options.establishOnline(retryExchangeCode);
    } catch {
      throw offlineError;
    }
  }
}

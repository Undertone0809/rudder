import type { CookieOptions } from "@supabase/ssr";

export type RootIdentityProvider = "google" | "github";
export type RootIdentitySignOutScope = "current" | "others" | "global";
export type RootIdentityOtpPurpose = "sign-in" | "email-verification";

export type RootIdentityCookieMutation = {
  name: string;
  value: string;
  options: CookieOptions;
};

/**
 * A request-scoped bridge between the root identity provider and Rudder's
 * same-origin HTTP handler. The handler owns the Node response; the adapter
 * owns auth-cookie policy and supplies every Set-Cookie/cache mutation here.
 */
export type RootIdentityRequestContext = {
  requestHeaders: Headers;
  setCookies: (
    cookies: RootIdentityCookieMutation[],
    responseHeaders: Readonly<Record<string, string>>,
  ) => void | Promise<void>;
};

export type RootIdentityPrincipal = {
  id: string;
  email: string;
  emailVerified: true;
  displayName: string | null;
  avatarUrl: string | null;
};

export type RootIdentityActiveSession = {
  userId: string;
  sessionId: string;
};

export type RootIdentityActiveSessionVerifier = (
  session: RootIdentityActiveSession,
) => Promise<boolean>;

export type RootIdentityBeforePasswordMutation = (
  principal: RootIdentityPrincipal,
) => Promise<void>;

export interface RootIdentityAdapter {
  getPrincipal(context: RootIdentityRequestContext): Promise<RootIdentityPrincipal | null>;
  /**
   * Resolves a principal only after the provider has confirmed both the user
   * and the concrete server-side session row are still active. Sensitive
   * account/device mutations must use this method rather than getPrincipal().
   */
  requireActivePrincipal(context: RootIdentityRequestContext): Promise<RootIdentityPrincipal>;
  beginOAuth(
    context: RootIdentityRequestContext,
    input: { provider: RootIdentityProvider; nextPath?: string },
  ): Promise<{ redirectUrl: string }>;
  completePkceCallback(
    context: RootIdentityRequestContext,
    input: { code: string },
  ): Promise<RootIdentityPrincipal>;
  sendEmailOtp(
    context: RootIdentityRequestContext,
    input: { email: string; nextPath?: string },
  ): Promise<void>;
  verifyEmailOtp(
    context: RootIdentityRequestContext,
    input: { email: string; token: string; purpose: RootIdentityOtpPurpose },
  ): Promise<RootIdentityPrincipal>;
  signUpWithPassword(
    context: RootIdentityRequestContext,
    input: { email: string; password: string },
  ): Promise<{ principal: RootIdentityPrincipal | null; verificationRequired: boolean }>;
  signInWithPassword(
    context: RootIdentityRequestContext,
    input: { email: string; password: string },
  ): Promise<RootIdentityPrincipal>;
  requestPasswordReset(
    context: RootIdentityRequestContext,
    input: { email: string },
  ): Promise<void>;
  resetPasswordWithOtp(
    context: RootIdentityRequestContext,
    input: { email: string; token: string; newPassword: string },
    beforeMutation: RootIdentityBeforePasswordMutation,
  ): Promise<RootIdentityPrincipal>;
  completePasswordRecovery(
    context: RootIdentityRequestContext,
    input: { code?: string; tokenHash?: string },
  ): Promise<RootIdentityPrincipal>;
  updateRecoveredPassword(
    context: RootIdentityRequestContext,
    input: { newPassword: string },
    beforeMutation: RootIdentityBeforePasswordMutation,
  ): Promise<RootIdentityPrincipal>;
  requestPasswordChangeVerification(context: RootIdentityRequestContext): Promise<void>;
  updatePassword(
    context: RootIdentityRequestContext,
    input: {
      newPassword: string;
      verificationCode: string;
      revokeOthers: boolean;
    },
    beforeMutation: RootIdentityBeforePasswordMutation,
  ): Promise<RootIdentityPrincipal>;
  signOut(
    context: RootIdentityRequestContext,
    scope: RootIdentitySignOutScope,
  ): Promise<void>;
}

export class RootIdentityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(input: { code?: string; message: string; status?: number }) {
    super(input.message);
    this.name = "RootIdentityError";
    this.code = input.code ?? "identity_provider_error";
    this.status = input.status ?? 400;
  }
}

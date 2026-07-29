const EFFECTIVE_DATE = "July 29, 2026";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Rudder Account</title>
  <style>
    :root { color-scheme: light dark; font-family: Geist, Avenir, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0b0c0f; color: #f5f5f4; }
    main { max-width: 720px; margin: 0 auto; padding: 72px 24px 96px; }
    a { color: #a7f3d0; } h1 { font-size: 2.5rem; letter-spacing: -.04em; }
    h2 { margin-top: 2rem; } p, li { color: #d6d3d1; line-height: 1.65; }
    nav { display: flex; gap: 20px; margin-top: 40px; }
    .eyebrow { color: #a7f3d0; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    section { display: grid; gap: 12px; margin-top: 32px; padding: 24px; border: 1px solid #292524; border-radius: 16px; }
    form { display: grid; gap: 12px; } label { display: grid; gap: 6px; }
    input, button { box-sizing: border-box; width: 100%; padding: 12px 14px; border: 1px solid #44403c; border-radius: 9px; font: inherit; }
    button { cursor: pointer; font-weight: 700; } button:disabled { cursor: not-allowed; opacity: .45; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function homePage(providers: { google: boolean; github: boolean }): string {
  return page(
    "Sign in",
    `<p class="eyebrow">Rudder Account</p>
     <h1>Your identity for Rudder.</h1>
     <p>Sign in securely from Rudder Desktop. Your Local Workspace content stays on your device and is not uploaded just because you sign in.</p>
     <section aria-labelledby="sign-in-heading">
       <h2 id="sign-in-heading">Sign in</h2>
       <button type="button" data-social="google"${providers.google ? "" : " disabled"}>Continue with Google</button>
       <button type="button" data-social="github"${providers.github ? "" : " disabled"}>Continue with GitHub</button>
       <form id="otp-form">
         <label>Email <input required type="email" name="email" autocomplete="email"></label>
         <button type="submit">Continue with email code</button>
       </form>
       <form id="otp-verify-form" hidden>
         <label>6-digit code <input required name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}"></label>
         <button type="submit">Verify code</button>
       </form>
       <details>
         <summary>Use password instead</summary>
         <form id="password-form">
           <label>Email <input required type="email" name="email" autocomplete="email"></label>
           <label>Password <input required type="password" name="password" minlength="8" maxlength="128" autocomplete="current-password"></label>
           <button type="submit">Sign in with password</button>
         </form>
         <form id="password-signup-form">
           <label>Name <input required name="name" autocomplete="name"></label>
           <label>Email <input required type="email" name="email" autocomplete="email"></label>
           <label>Password <input required type="password" name="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
           <button type="submit">Create account with password</button>
         </form>
         <form id="forgot-password-form">
           <label>Email <input required type="email" name="email" autocomplete="email"></label>
           <button type="submit">Forgot password</button>
         </form>
         <form id="reset-password-form" hidden>
           <label>6-digit reset code <input required name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}"></label>
           <label>New password <input required type="password" name="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
           <button type="submit">Reset password</button>
         </form>
       </details>
       <p id="auth-status" role="status" aria-live="polite"></p>
     </section>
     <nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
     <script src="/identity.js" defer></script>`,
  );
}

export function accountPage(email: string): string {
  return page(
    "Account & Security",
    `<p class="eyebrow">Rudder Account</p>
     <h1>Account &amp; Security</h1>
     <p>Signed in as ${escapeHtml(email)}</p>
     <section>
       <h2>Set a password</h2>
       <p>For an account that currently uses Google, GitHub, or email codes. Email verification is required immediately before setting it.</p>
       <form id="set-password-request-form"><button type="submit">Send verification code</button></form>
       <form id="set-password-form" hidden>
         <label>6-digit code <input required name="otp" pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code"></label>
         <label>New password <input required type="password" name="newPassword" minlength="8" maxlength="128" autocomplete="new-password"></label>
         <button type="submit">Set password</button>
       </form>
     </section>
     <section>
       <h2>Change password</h2>
       <form id="change-password-form">
         <label>Current password <input required type="password" name="currentPassword" autocomplete="current-password"></label>
         <label>New password <input required type="password" name="newPassword" minlength="8" maxlength="128" autocomplete="new-password"></label>
         <label><input type="checkbox" name="revokeOtherSessions" checked> Sign out other sessions</label>
         <button type="submit">Change password</button>
       </form>
     </section>
     <section>
       <h2>Web sessions</h2>
       <p>Browser sign-ins are managed separately from Rudder Desktop devices.</p>
       <div id="web-session-list">Loading web sessions…</div>
       <button type="button" id="revoke-other-web-sessions">Sign out other web sessions</button>
     </section>
     <section>
       <h2>Devices</h2>
       <div id="device-list">Loading devices…</div>
     </section>
     <section>
       <h2>Sign out</h2>
       <p>This signs out the current web session only. Rudder Desktop devices remain connected until you revoke them above.</p>
       <button type="button" id="sign-out">Sign out of this web session</button>
     </section>
     <p id="auth-status" role="status" aria-live="polite"></p>
     <nav><a href="/">Rudder Account</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
     <script src="/identity.js" defer></script>`,
  );
}

export function deviceApprovalPage(userCode: string): string {
  return page(
    "Approve device",
    `<p class="eyebrow">Rudder Account</p>
     <h1>Approve device</h1>
     <p>A Rudder device wants to sign in. Confirm that this code matches the device:</p>
     <p><strong id="device-user-code">${escapeHtml(userCode)}</strong></p>
     <section>
       <button type="button" id="approve-device">Approve</button>
       <button type="button" id="deny-device">Deny</button>
     </section>
     <p id="auth-status" role="status" aria-live="polite"></p>
     <nav><a href="/account">Account &amp; Security</a><a href="/privacy">Privacy</a></nav>
     <script src="/identity.js" defer></script>`,
  );
}

export function privacyPage(supportEmail: string): string {
  const contact = escapeHtml(supportEmail);
  return page(
    "Privacy Policy",
    `<p class="eyebrow">Rudder Account</p>
     <h1>Privacy Policy</h1>
     <p>Effective: ${EFFECTIVE_DATE}</p>
     <h2>What account data we process</h2>
     <p>Rudder Identity processes the email address, display name and avatar you provide; your Google or GitHub provider identifier; password credentials stored as one-way hashes; verification challenges; login sessions; registered devices; and limited security events used to prevent abuse and let you revoke access.</p>
     <h2>Local data stays local</h2>
     <p>Signing in does not upload your Local Organizations, Workspaces, files, paths, prompts, transcripts, runs, runtime credentials, or provider access tokens to Rudder Identity. Those remain in your Local Rudder installation unless you separately choose a future remote or sharing feature.</p>
     <h2>Service providers</h2>
     <p>We use Google and GitHub when you choose their sign-in methods, Resend to deliver verification and security email, Supabase to host the private PostgreSQL account database, and Vercel to run the Identity service. Each processes only the information needed to provide that function.</p>
     <h2>Retention and security</h2>
     <p>We retain account and security data while your account is active and as reasonably needed for security, legal compliance, and fraud prevention. Verification codes and authorization codes expire quickly and are stored only in hashed form. Provider access and refresh tokens are not retained by Rudder Identity.</p>
     <h2>Your choices and deletion</h2>
     <p>You can revoke sessions and linked login methods from Account &amp; Security. To request access, correction, export, or deletion of your Rudder Account data, email <a href="mailto:${contact}">${contact}</a>. Deleting a Rudder Account does not silently delete Local Workspace data on your devices.</p>
     <nav><a href="/">Rudder Account</a><a href="/terms">Terms</a></nav>`,
  );
}

export function termsPage(supportEmail: string): string {
  const contact = escapeHtml(supportEmail);
  return page(
    "Terms of Service",
    `<p class="eyebrow">Rudder Account</p>
     <h1>Terms of Service</h1>
     <p>Effective: ${EFFECTIVE_DATE}</p>
     <h2>Using Rudder Account</h2>
     <p>Rudder Account provides identity, device, and server-connection services for Rudder. You must provide accurate information, protect your login methods, and promptly revoke devices or sessions you no longer control.</p>
     <h2>Acceptable use</h2>
     <p>Do not misuse the service, attempt unauthorized access, disrupt authentication or email delivery, evade rate limits, or use Rudder Account to violate applicable law or another person's rights.</p>
     <h2>Availability and changes</h2>
     <p>The service may change as Rudder develops. We work to keep account access reliable, but do not promise uninterrupted availability. We may suspend access where reasonably necessary to protect users or the service.</p>
     <h2>Your Local data</h2>
     <p>Rudder Account does not take ownership of Local Workspace content. Signing in alone does not upload that content. You remain responsible for your Local data, backups, agents, and actions performed through Rudder.</p>
     <h2>Contact</h2>
     <p>Questions, account deletion requests, and security reports can be sent to <a href="mailto:${contact}">${contact}</a>.</p>
     <nav><a href="/">Rudder Account</a><a href="/privacy">Privacy</a></nav>`,
  );
}

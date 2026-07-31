const EFFECTIVE_DATE = "July 29, 2026";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title: string, body: string, layout: "document" | "auth" = "document"): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <title>${escapeHtml(title)} · Rudder Account</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Geist, "Avenir Next", ui-sans-serif, system-ui, -apple-system, sans-serif;
      --page: #f1f0ec;
      --surface: #fbfaf7;
      --surface-raised: #ffffff;
      --surface-muted: #f3f2ee;
      --text: #20211f;
      --muted: #676963;
      --faint: #92958d;
      --line: #deddd7;
      --line-strong: #cbc9c1;
      --primary: #20211f;
      --primary-text: #fbfaf7;
      --focus: #2f7d5a;
      --positive: #256f4d;
      --negative: #b33a35;
      --shadow: rgba(54, 52, 45, .11);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: var(--page); color: var(--text); }
    main { max-width: 760px; margin: 0 auto; padding: 72px 24px 96px; }
    a { color: inherit; text-underline-offset: 3px; }
    h1 { margin: 16px 0; font-size: clamp(2rem, 5vw, 2.75rem); letter-spacing: -.045em; line-height: 1.04; }
    h2 { margin-top: 2rem; }
    p, li { color: var(--muted); line-height: 1.65; }
    nav { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 40px; }
    .eyebrow { color: var(--positive); font-size: .78rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
    section { display: grid; gap: 12px; margin-top: 32px; padding: 24px; border: 1px solid var(--line); border-radius: 16px; background: color-mix(in srgb, var(--surface) 78%, transparent); }
    form { display: grid; gap: 14px; }
    label { display: grid; gap: 7px; color: var(--text); font-size: .82rem; font-weight: 650; }
    input, button { box-sizing: border-box; width: 100%; min-height: 46px; padding: 11px 13px; border: 1px solid var(--line-strong); border-radius: 10px; font: inherit; }
    input { background: var(--surface-raised); color: var(--text); outline: none; }
    input::placeholder { color: var(--faint); }
    input[type="checkbox"] { width: auto; min-height: 0; }
    input:focus-visible, button:focus-visible, summary:focus-visible, a:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--focus) 32%, transparent);
      outline-offset: 2px;
    }
    button { cursor: pointer; background: var(--surface-raised); color: var(--text); font-weight: 700; transition: transform 140ms ease, border-color 140ms ease, background 140ms ease; }
    button:hover:not(:disabled) { border-color: var(--text); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button:disabled { cursor: not-allowed; opacity: .48; }
    button[data-loading="true"] { cursor: progress; opacity: .68; }
    .auth-page { min-height: 100dvh; display: grid; place-items: center; padding: 48px 20px; }
    .auth-page main { width: 100%; max-width: 440px; margin: 0; padding: 0; }
    .auth-card {
      display: block;
      width: 100%;
      margin: 0;
      padding: 34px;
      border: 1px solid color-mix(in srgb, var(--line) 86%, transparent);
      border-radius: 22px;
      background: var(--surface);
      box-shadow: 0 24px 64px -36px var(--shadow), 0 8px 24px -18px var(--shadow);
    }
    .brand-mark {
      display: grid;
      width: 44px;
      height: 44px;
      margin: 0 auto 20px;
      place-items: center;
      border: 1px solid var(--line-strong);
      border-radius: 12px;
      background: var(--primary);
      color: var(--primary-text);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 14%, transparent);
      overflow: hidden;
    }
    .brand-mark img { display: block; width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
    .auth-heading { margin: 0; text-align: center; font-size: 1.72rem; letter-spacing: -.035em; line-height: 1.15; }
    .auth-intro { max-width: 34ch; margin: 10px auto 26px; text-align: center; color: var(--muted); font-size: .92rem; line-height: 1.55; }
    .social-stack { display: grid; gap: 10px; }
    .social-button { position: relative; display: grid; grid-template-columns: 22px 1fr 22px; align-items: center; background: var(--surface-raised); }
    .social-button svg { width: 18px; height: 18px; }
    .social-button span { grid-column: 2; }
    .divider { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; margin: 22px 0; color: var(--faint); font-size: .68rem; font-weight: 780; letter-spacing: .12em; text-transform: uppercase; }
    .divider::before, .divider::after { content: ""; height: 1px; background: var(--line); }
    .primary-button { border-color: var(--primary); background: var(--primary); color: var(--primary-text); }
    .primary-button:hover:not(:disabled) { background: color-mix(in srgb, var(--primary) 91%, white); }
    .auth-form + .auth-form { margin-top: 14px; }
    .otp-form { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
    .step-context { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--muted); font-size: .78rem; }
    .step-context strong { color: var(--text); font-weight: 680; }
    .text-button { width: auto; min-height: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--muted); font-size: .76rem; text-decoration: underline; text-underline-offset: 3px; }
    .text-button:hover:not(:disabled) { border-color: transparent; color: var(--text); }
    .mode-toggle { display: block; width: fit-content; min-height: 0; margin: 18px auto 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--muted); font-size: .82rem; font-weight: 680; }
    .mode-toggle::after { content: " →"; }
    .mode-toggle:hover:not(:disabled) { border-color: transparent; color: var(--text); }
    .password-panel { margin-top: 18px; }
    .password-section { display: grid; gap: 14px; padding-top: 18px; border-top: 1px solid var(--line); }
    .password-section + .password-section { margin-top: 18px; }
    .password-section h2 { margin: 0; font-size: .9rem; letter-spacing: -.01em; }
    .password-section p { margin: -6px 0 0; font-size: .78rem; line-height: 1.5; }
    .secondary-disclosure > summary { color: var(--muted); cursor: pointer; font-size: .8rem; font-weight: 650; }
    .secondary-disclosure form { margin-top: 14px; }
    .auth-status { min-height: 20px; margin: 16px 0 0; text-align: center; font-size: .8rem; line-height: 1.45; }
    .auth-status[data-state="error"] { color: var(--negative); }
    .auth-status[data-state="success"] { color: var(--positive); }
    .auth-privacy { margin: 22px auto 0; text-align: center; color: var(--faint); font-size: .74rem; line-height: 1.5; }
    .auth-legal { display: flex; justify-content: center; gap: 18px; margin-top: 12px; color: var(--muted); font-size: .75rem; }
    [hidden] { display: none !important; }
    @media (prefers-color-scheme: dark) {
      :root {
        --page: #171816;
        --surface: #20211f;
        --surface-raised: #272825;
        --surface-muted: #242522;
        --text: #f1f0eb;
        --muted: #b1b3ac;
        --faint: #858880;
        --line: #363833;
        --line-strong: #474a43;
        --primary: #f1f0eb;
        --primary-text: #1d1e1b;
        --focus: #70b58f;
        --positive: #8dc9a7;
        --negative: #f08c85;
        --shadow: rgba(0, 0, 0, .42);
      }
    }
    @media (max-width: 520px) {
      .auth-page { padding: 20px 14px; align-items: start; }
      .auth-card { padding: 28px 22px; border-radius: 18px; }
    }
    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
    }
  </style>
</head>
<body class="${layout === "auth" ? "auth-page" : "document-page"}"><main>${body}</main></body>
</html>`;
}

export function homePage(providers: { google: boolean; github: boolean }): string {
  return page(
    "Sign in",
    `<section class="auth-card" aria-labelledby="sign-in-heading">
       <div class="brand-mark" aria-hidden="true">
         <img src="/rudder-logo.png" alt="">
       </div>
       <h1 class="auth-heading" id="sign-in-heading">Welcome to Rudder</h1>
       <p class="auth-intro">Sign in to connect this device. Your Local Workspace stays on your machine.</p>
       <div class="social-stack" role="group" aria-label="Social sign in">
         <button class="social-button" type="button" data-social="google"${providers.google ? "" : " disabled"}>
           <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.19-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.55h3.24c1.9-1.75 2.98-4.33 2.98-7.42Z"/><path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.05v2.62A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.39 13.86A6 6 0 0 1 6.08 12c0-.65.11-1.28.31-1.86V7.52H3.05A10 10 0 0 0 2 12c0 1.61.38 3.14 1.05 4.48l3.34-2.62Z"/><path fill="#EA4335" d="M12 6.01c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.95 5.52l3.34 2.62C7.18 7.77 9.39 6.01 12 6.01Z"/></svg>
           <span>Continue with Google</span>
         </button>
         <button class="social-button" type="button" data-social="github"${providers.github ? "" : " disabled"}>
           <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48l-.01-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.54 1.03 1.54 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.57 9.57 0 0 1 12 6.82c.85 0 1.7.11 2.5.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.86l-.01 2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>
           <span>Continue with GitHub</span>
         </button>
       </div>
       <div class="divider">or continue with email</div>
       <form class="auth-form" id="otp-form">
         <label>Email address <input required type="email" name="email" autocomplete="email" placeholder="you@example.com"></label>
         <button class="primary-button" type="submit">Continue with email code</button>
       </form>
       <form class="auth-form otp-form" id="otp-verify-form" hidden>
         <div class="step-context">
           <span>Code sent to <strong id="otp-email"></strong></span>
           <button class="text-button" id="change-email" type="button">Change email</button>
         </div>
         <label>Verification code <input required name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" maxlength="8" placeholder="00000000"></label>
         <button class="primary-button" type="submit">Verify and continue</button>
       </form>
       <button class="mode-toggle" id="password-mode-toggle" type="button" aria-controls="password-panel" aria-expanded="false">Use password instead</button>
       <div class="password-panel" id="password-panel" hidden>
         <div class="password-section">
           <h2>Password sign in</h2>
           <form class="auth-form" id="password-form">
             <label>Email address <input required type="email" name="email" autocomplete="email"></label>
             <label>Password <input required type="password" name="password" minlength="8" maxlength="128" autocomplete="current-password"></label>
             <button class="primary-button" type="submit">Sign in with password</button>
           </form>
           <details class="secondary-disclosure">
             <summary>Create a password account</summary>
             <form class="auth-form" id="password-signup-form">
               <label>Email address <input required type="email" name="email" autocomplete="email"></label>
               <label>Password <input required type="password" name="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
               <button type="submit">Create account with password</button>
             </form>
           </details>
           <details class="secondary-disclosure">
             <summary>Forgot password?</summary>
             <form class="auth-form" id="forgot-password-form">
               <label>Email address <input required type="email" name="email" autocomplete="email"></label>
               <button type="submit">Send reset code</button>
             </form>
             <form class="auth-form otp-form" id="reset-password-form" hidden>
               <label>Reset code <input required name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" maxlength="8"></label>
               <label>New password <input required type="password" name="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
               <button class="primary-button" type="submit">Reset password</button>
             </form>
           </details>
         </div>
       </div>
       <p class="auth-status" id="auth-status" role="status" aria-live="polite"></p>
       <p class="auth-privacy">Signing in connects your identity and devices. It does not upload Local Workspace content.</p>
       <nav class="auth-legal"><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
     </section>
     <script src="/identity.js?v=20260730-login-card" defer></script>`,
    "auth",
  );
}

export function accountPage(email: string): string {
  return page(
    "Account & Security",
    `<p class="eyebrow">Rudder Account</p>
     <h1>Account &amp; Security</h1>
     <p>Signed in as ${escapeHtml(email)}</p>
     <section>
       <h2>Set or change password</h2>
       <p>Confirm this account by email immediately before setting a new password.</p>
       <form id="set-password-request-form"><button type="submit">Send verification code</button></form>
       <form id="set-password-form" hidden>
         <label>Verification code <input required name="otp" pattern="[0-9]{6,8}" maxlength="8" inputmode="numeric" autocomplete="one-time-code"></label>
         <label>New password <input required type="password" name="newPassword" minlength="8" maxlength="128" autocomplete="new-password"></label>
         <label><input type="checkbox" name="revokeOthers" value="yes"> Sign out other browsers and revoke Rudder Desktop access</label>
         <button type="submit">Save new password</button>
       </form>
     </section>
     <section>
       <h2>Web sessions</h2>
       <p>This browser and other-browser actions leave Rudder Desktop access unchanged. Signing out everywhere also revokes Rudder Desktop cloud access; an already-issued Local Server session ends at its local expiry or next identity sync.</p>
       <button type="button" data-sign-out-scope="current">Sign out this browser</button>
       <button type="button" data-sign-out-scope="others">Sign out other browsers</button>
       <button type="button" data-sign-out-scope="global">Sign out all browsers</button>
     </section>
     <section>
       <h2>Devices</h2>
       <div id="device-list">Loading devices…</div>
     </section>
     <p id="auth-status" role="status" aria-live="polite"></p>
     <nav><a href="/">Rudder Account</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
     <script src="/identity.js" defer></script>`,
  );
}

export function passwordRecoveryPage(email: string): string {
  return page(
    "Reset password",
    `<section class="auth-card" aria-labelledby="recovery-heading">
       <div class="brand-mark"><img src="/rudder-logo.png" alt="Rudder"></div>
       <h1 class="auth-heading" id="recovery-heading">Choose a new password</h1>
       <p class="auth-intro">Resetting ${escapeHtml(email)} signs out every browser and revokes Rudder Desktop cloud access. An already-issued Local Server session ends at its local expiry or next identity sync.</p>
       <form class="auth-form" id="recovery-password-form">
         <label>New password <input required type="password" name="password" minlength="8" maxlength="128" autocomplete="new-password"></label>
         <button class="primary-button" type="submit">Reset password and sign out devices</button>
       </form>
       <p class="auth-status" id="auth-status" role="status" aria-live="polite"></p>
       <nav class="auth-legal"><a href="/">Cancel</a><a href="/privacy">Privacy</a></nav>
     </section>
     <script src="/identity.js" defer></script>`,
    "auth",
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
     <p>Supabase Auth processes the email address, display name and avatar you provide; your Google or GitHub provider identifier; password credentials stored as one-way hashes; verification challenges; and browser sessions. Rudder Identity processes registered devices and limited security events used to prevent abuse and let you revoke access.</p>
     <h2>Local data stays local</h2>
     <p>Signing in does not upload your Local Organizations, Workspaces, files, paths, prompts, transcripts, runs, runtime credentials, or provider access tokens to Rudder Identity. Those remain in your Local Rudder installation unless you separately choose a future remote or sharing feature.</p>
     <h2>Service providers</h2>
     <p>We use Google and GitHub when you choose their sign-in methods, Supabase Auth for account authentication and browser sessions, Resend to deliver verification and security email, Supabase PostgreSQL for private Rudder device data, and Vercel to run the Identity service. Each processes only the information needed to provide that function.</p>
     <h2>Retention and security</h2>
     <p>We retain account and security data while your account is active and as reasonably needed for security, legal compliance, and fraud prevention. Verification codes and authorization codes expire quickly and are stored only in hashed form. Provider access and refresh tokens are not retained by Rudder Identity.</p>
     <h2>Your choices and deletion</h2>
     <p>You can revoke browser sessions and registered devices from Account &amp; Security. To request access, correction, export, or deletion of your Rudder Account data, email <a href="mailto:${contact}">${contact}</a>. Deleting a Rudder Account does not silently delete Local Workspace data on your devices.</p>
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

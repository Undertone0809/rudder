function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export type BootScreenState = {
  view: "loading" | "account_required" | "failed";
  stage: string;
  failure?: {
    id: string;
    occurredAt: string;
    attempt: number;
    category: string;
    summary: string;
  };
  runtime?: {
    profile?: string | null;
    instance?: string | null;
    version?: string | null;
  };
  instanceRoot?: string | null;
};

export function deriveBootScreenState(state: {
  stage: string;
  failure?: BootScreenState["failure"];
  runtime?: {
    localEnv?: string | null;
    instanceId?: string | null;
    version?: string | null;
  };
  paths?: { instanceRoot?: string | null };
}): BootScreenState {
  return {
    view: state.stage === "error"
      ? "failed"
      : state.stage === "account_required"
        ? "account_required"
        : "loading",
    stage: state.stage,
    ...(state.failure ? { failure: state.failure } : {}),
    runtime: {
      profile: state.runtime?.localEnv,
      instance: state.runtime?.instanceId,
      version: state.runtime?.version,
    },
    instanceRoot: state.paths?.instanceRoot,
  };
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function createBootScreenHtml(
  appName: string,
  brandIconDataUrl: string | null,
  initialState: BootScreenState,
): string {
  const title = escapeHtml(appName);
  const brandMark = brandIconDataUrl
    ? `<img src="${escapeHtml(brandIconDataUrl)}" alt="" />`
    : `<span class="brand-fallback" aria-hidden="true">R</span>`;
  const initialStateJson = serializeForInlineScript(initialState);
  const initialFailure = initialState.view === "failed";
  const initialAccountRequired = initialState.view === "account_required";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light dark;
        --shell: #f1f0ec;
        --paper: #fbfaf7;
        --paper-raised: #ffffff;
        --paper-solid: #fbfaf7;
        --text: #20211f;
        --muted: #676963;
        --faint: #92958d;
        --border: #deddd7;
        --border-strong: #cbc9c1;
        --accent: #20211f;
        --accent-hover: #30312e;
        --danger: #a0444d;
        --focus: #2f7d5a;
        --shadow: rgba(54, 52, 45, 0.11);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --shell: #171816;
          --paper: #20211f;
          --paper-raised: #272825;
          --paper-solid: #20211f;
          --text: #f1f0eb;
          --muted: #b1b3ac;
          --faint: #858880;
          --border: #363833;
          --border-strong: #474a43;
          --accent: #f1f0eb;
          --accent-hover: #ffffff;
          --danger: #e39aa1;
          --focus: #70b58f;
          --shadow: rgba(0, 0, 0, 0.42);
        }
      }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      html { min-height: 100%; background: transparent; }
      body {
        margin: 0;
        min-height: 100vh;
        overflow: auto;
        font-family: Geist, "Avenir Next", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        background: var(--shell);
        color: var(--text);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .boot-shell {
        min-height: 100vh;
        display: grid;
        justify-items: center;
        align-items: safe center;
        padding: 72px 28px 40px;
      }
      .loading-view {
        width: 148px;
        height: 148px;
        display: grid;
        place-items: center;
      }
      .brand-stage {
        position: relative;
        width: 132px;
        height: 132px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border);
        border-radius: 50%;
        transition: border-color 180ms ease, opacity 180ms ease;
      }
      .brand-stage::before,
      .brand-stage::after {
        content: "";
        position: absolute;
        left: 50%;
        width: 1px;
        height: 9px;
        background: var(--border-strong);
        transform: translateX(-50%);
      }
      .brand-stage::before { top: -5px; }
      .brand-stage::after { bottom: -5px; }
      .brand-mark {
        width: 76px;
        height: 76px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        overflow: hidden;
        animation: correct-course 2100ms cubic-bezier(0.2, 0, 0, 1) infinite;
        transform-origin: center;
      }
      .brand-mark img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .brand-fallback {
        width: 76px;
        height: 76px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: #111;
        color: #fff;
        font-size: 30px;
        font-weight: 650;
      }
      @keyframes correct-course {
        0%, 14%, 100% { transform: rotate(0deg); }
        30% { transform: rotate(-6deg); }
        52% { transform: rotate(8deg); }
        70% { transform: rotate(0deg); }
      }
      body[data-stage="database"] .brand-stage { border-color: color-mix(in srgb, var(--accent) 36%, transparent); }
      body[data-stage="app"] .brand-stage,
      body[data-stage="listening"] .brand-stage { border-color: color-mix(in srgb, var(--accent) 62%, transparent); }
      .failure-sheet {
        width: min(560px, calc(100vw - 56px));
        margin: auto;
        padding: 24px;
        background: var(--paper);
        border: 1px solid var(--border-strong);
        border-left: 2px solid var(--danger);
        border-radius: 8px;
        box-shadow: 0 24px 64px rgba(29, 32, 36, 0.16);
        opacity: 0;
        transform: translateY(8px);
        animation: reveal-failure 240ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
      .account-sheet {
        width: min(440px, calc(100vw - 40px));
        padding: 34px;
        background: var(--paper);
        border: 1px solid var(--border);
        border-radius: 22px;
        box-shadow: 0 24px 64px -36px var(--shadow), 0 8px 24px -18px var(--shadow);
      }
      .account-brand {
        width: 44px;
        height: 44px;
        display: grid;
        margin: 0 auto 20px;
        place-items: center;
        overflow: hidden;
        border: 1px solid var(--border-strong);
        border-radius: 12px;
        background: #20211f;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
      }
      .account-brand img { width: 32px; height: 32px; object-fit: contain; }
      .account-brand .brand-fallback { width: 32px; height: 32px; border-radius: 0; font-size: 17px; }
      .account-sheet h1 {
        text-align: center;
        font-size: 28px;
        letter-spacing: -0.035em;
        line-height: 1.15;
      }
      #account-title:focus { outline: none; }
      .account-intro {
        max-width: 34ch;
        margin: 10px auto 26px;
        color: var(--muted);
        text-align: center;
        font-size: 14px;
        line-height: 1.55;
      }
      .social-stack { display: grid; gap: 10px; }
      .auth-button {
        position: relative;
        width: 100%;
        min-height: 48px;
        display: grid;
        grid-template-columns: 22px 1fr 22px;
        align-items: center;
        border-color: var(--border-strong);
        border-radius: 10px;
        background: var(--paper-raised);
        color: var(--text);
        font-weight: 700;
      }
      .auth-button:hover:not(:disabled) { border-color: var(--text); background: var(--paper-raised); }
      .auth-button svg { width: 18px; height: 18px; }
      .auth-button span { grid-column: 2; }
      .divider {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        gap: 12px;
        align-items: center;
        margin: 22px 0;
        color: var(--faint);
        font-size: 11px;
        font-weight: 760;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .divider::before, .divider::after { content: ""; height: 1px; background: var(--border); }
      .email-form { display: grid; gap: 8px; }
      .email-form label { color: var(--text); font-size: 13px; font-weight: 650; }
      .email-form input {
        width: 100%;
        min-height: 48px;
        margin-top: 7px;
        padding: 11px 13px;
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        outline: none;
        background: var(--paper-raised);
        color: var(--text);
        font: inherit;
      }
      .email-form input::placeholder { color: var(--faint); }
      .email-form input:focus-visible {
        border-color: var(--focus);
        outline: 3px solid color-mix(in srgb, var(--focus) 30%, transparent);
        outline-offset: 1px;
      }
      .auth-primary {
        width: 100%;
        min-height: 48px;
        margin-top: 8px;
        border-radius: 10px;
        background: var(--accent);
        color: var(--paper-solid);
        font-weight: 700;
      }
      @media (prefers-color-scheme: dark) {
        .auth-primary { color: #1d1e1b; }
      }
      .auth-primary:hover:not(:disabled) { background: var(--accent-hover); }
      .mode-toggle {
        display: block;
        width: fit-content;
        min-height: 32px;
        margin: 12px auto 0;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--muted);
        font-size: 13px;
        font-weight: 680;
      }
      .mode-toggle::after { content: " →"; }
      .mode-toggle:hover:not(:disabled) { color: var(--text); transform: none; }
      .password-panel {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid var(--border);
      }
      .password-panel p {
        margin: 0 0 12px;
        color: var(--muted);
        text-align: center;
        font-size: 12px;
        line-height: 1.5;
      }
      .password-actions { display: grid; gap: 8px; }
      .native-auth-panel { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
      .password-recovery {
        width: fit-content;
        min-height: 30px;
        margin: 0 auto;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--muted);
        font-size: 12px;
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .password-recovery:hover:not(:disabled) { color: var(--text); transform: none; }
      .account-sheet .inline-status { text-align: center; }
      .account-sheet .privacy-note {
        margin: 22px auto 0;
        color: var(--faint);
        text-align: center;
        font-size: 12px;
        line-height: 1.5;
      }
      .account-sheet .privacy-note strong { color: inherit; }
      .device-approval { margin-top: 18px; padding: 14px; border: 1px solid var(--border); border-radius: 8px; }
      .device-code { margin-top: 8px; font: 650 24px/1.2 ui-monospace, "SFMono-Regular", monospace; letter-spacing: 0.08em; }
      .device-url { margin-top: 8px; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, "SFMono-Regular", monospace; }
      @keyframes reveal-failure { to { opacity: 1; transform: translateY(0); } }
      .failure-header { display: flex; align-items: flex-start; gap: 14px; }
      .failure-mark {
        width: 32px;
        height: 32px;
        flex: 0 0 32px;
        overflow: hidden;
        border-radius: 50%;
      }
      .failure-mark img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .failure-mark .brand-fallback { width: 32px; height: 32px; font-size: 14px; }
      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
        font-weight: 650;
      }
      #failure-title:focus { outline: none; }
      p { margin: 0; }
      .failure-summary { margin-top: 7px; color: var(--muted); font-size: 14px; line-height: 1.5; }
      .actions { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 8px; }
      button {
        min-height: 36px;
        appearance: none;
        border: 1px solid transparent;
        border-radius: 6px;
        padding: 0 14px;
        font: inherit;
        font-size: 14px;
        font-weight: 560;
        cursor: pointer;
        transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease;
      }
      button:hover:not(:disabled) { transform: translateY(-1px); }
      button:active:not(:disabled) { transform: translateY(0); }
      button:disabled { cursor: default; opacity: 0.58; }
      button:focus-visible,
      summary:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--focus) 62%, transparent);
        outline-offset: 3px;
      }
      .primary { background: var(--accent); color: var(--paper-solid); }
      .primary:hover:not(:disabled) { background: var(--accent-hover); }
      .secondary { background: transparent; color: var(--text); border-color: var(--border-strong); }
      .tertiary { min-height: 32px; padding: 0; background: transparent; color: var(--accent); }
      .support-guide {
        margin-top: 22px;
        padding-top: 18px;
        border-top: 1px solid var(--border);
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
      }
      .support-guide > strong { display: block; color: var(--text); font-weight: 620; }
      .report-paths {
        margin: 10px 0 0;
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr);
        gap: 6px 12px;
      }
      .report-paths dt { color: var(--text); font-weight: 620; }
      .report-paths dd { margin: 0; }
      .report-checklist-title { margin-top: 14px; }
      .support-guide ol { margin: 7px 0 0; padding-left: 20px; }
      .support-guide li + li { margin-top: 4px; }
      .privacy-note { margin-top: 12px; }
      .privacy-note strong { color: var(--text); font-weight: 620; }
      details { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
      summary { width: fit-content; cursor: pointer; color: var(--text); font-size: 13px; font-weight: 600; }
      .diagnostic-grid {
        margin: 14px 0 0;
        display: grid;
        grid-template-columns: minmax(90px, 0.35fr) minmax(0, 1fr);
        gap: 8px 12px;
        font-size: 12px;
      }
      .diagnostic-grid dt { color: var(--muted); }
      .diagnostic-grid dd {
        margin: 0;
        min-width: 0;
        font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
        overflow-wrap: anywhere;
      }
      .technical-actions { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 16px; }
      .inline-status { min-height: 20px; margin-top: 12px; color: var(--muted); font-size: 12px; line-height: 1.45; }
      .fallback-actions { display: flex; flex-wrap: wrap; gap: 16px; }
      @media (max-width: 620px) {
        .boot-shell { padding-inline: 18px; }
        .account-sheet { width: min(100%, 440px); padding: 28px 22px; border-radius: 18px; }
        .failure-sheet { width: min(100%, 560px); padding: 20px; }
        .report-paths { grid-template-columns: 1fr; gap: 2px; }
        .report-paths dd + dt { margin-top: 6px; }
        .diagnostic-grid { grid-template-columns: 1fr; gap: 3px; }
        .diagnostic-grid dd + dt { margin-top: 7px; }
      }
      @media (prefers-contrast: more) {
        body { background: var(--paper-solid); }
        .brand-stage, .failure-sheet, .secondary, details, .support-guide { border-color: currentColor; }
        .failure-sheet { border-left-color: var(--danger); }
      }
      @media (forced-colors: active) {
        body, .failure-sheet, .account-sheet { background: Canvas; color: CanvasText; }
        .brand-stage, .failure-sheet, .secondary { border: 1px solid CanvasText; }
        .failure-sheet { border-left: 3px solid Highlight; }
        .primary { background: Highlight; color: HighlightText; }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; }
        .failure-sheet { opacity: 1; transform: none; }
        button:hover:not(:disabled), button:active:not(:disabled) { transform: none; }
      }
    </style>
  </head>
  <body data-boot-view="${initialFailure ? "failed" : initialAccountRequired ? "account_required" : "loading"}" data-stage="${escapeHtml(initialState.stage)}">
    <main class="boot-shell" id="boot-shell" aria-busy="${initialFailure || initialAccountRequired ? "false" : "true"}">
      <p class="sr-only" role="status" aria-live="polite">Rudder is opening.</p>
      <section class="loading-view" id="loading-view" aria-hidden="true"${initialFailure || initialAccountRequired ? " hidden" : ""}>
        <div class="brand-stage">
          <div class="brand-mark">${brandMark}</div>
        </div>
      </section>
      <section class="account-sheet" id="account-sheet" role="region" aria-labelledby="account-title"${initialAccountRequired ? "" : " hidden"}>
        <div class="account-brand">${brandMark}</div>
        <h1 id="account-title" tabindex="-1">Welcome to Rudder</h1>
        <p class="account-intro">Sign in to connect this device. Your Local Workspace stays on your machine.</p>
        <div class="social-stack" role="group" aria-label="Social sign in">
          <button class="auth-button auth-entry" id="google-sign-in-button" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.19-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.55h3.24c1.9-1.75 2.98-4.33 2.98-7.42Z"/><path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.05v2.62A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.39 13.86A6 6 0 0 1 6.08 12c0-.65.11-1.28.31-1.86V7.52H3.05A10 10 0 0 0 2 12c0 1.61.38 3.14 1.05 4.48l3.34-2.62Z"/><path fill="#EA4335" d="M12 6.01c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.95 5.52l3.34 2.62C7.18 7.77 9.39 6.01 12 6.01Z"/></svg>
            <span>Continue with Google</span>
          </button>
          <button class="auth-button auth-entry" id="github-sign-in-button" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48l-.01-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.54 1.03 1.54 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.57 9.57 0 0 1 12 6.82c.85 0 1.7.11 2.5.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.86l-.01 2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>
            <span>Continue with GitHub</span>
          </button>
        </div>
        <div class="divider">or continue with email</div>
        <form class="email-form" id="email-sign-in-form">
          <label>Email address
            <input id="account-email" required type="email" autocomplete="email" placeholder="you@example.com">
          </label>
          <button class="auth-primary auth-entry" id="email-code-submit-button" type="submit">Continue with email code</button>
        </form>
        <form class="email-form native-auth-panel" id="email-code-form" hidden>
          <label>Verification code
            <input id="account-email-code" required type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" maxlength="8" placeholder="Email code">
          </label>
          <button class="auth-primary auth-entry" type="submit">Verify and sign in</button>
          <button class="password-recovery" id="email-code-back-button" type="button">Use a different email</button>
        </form>
        <button class="mode-toggle" id="password-mode-toggle" type="button" aria-controls="password-panel" aria-expanded="false">Use password instead</button>
        <div class="password-panel" id="password-panel" hidden>
          <form class="email-form" id="password-sign-in-form">
            <label>Password
              <input id="account-password" required type="password" minlength="8" maxlength="128" autocomplete="current-password" placeholder="Your password">
            </label>
            <button class="auth-primary auth-entry" type="submit">Sign in with password</button>
          </form>
          <button class="password-recovery auth-entry" id="password-reset-button" type="button">Forgot or need to set a password?</button>
          <form class="email-form native-auth-panel" id="password-reset-form" hidden>
            <label>Reset code
              <input id="password-reset-code" required type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" maxlength="8" placeholder="Reset code">
            </label>
            <label>New password
              <input id="new-password" required type="password" minlength="8" maxlength="128" autocomplete="new-password" placeholder="At least 8 characters">
            </label>
            <button class="auth-primary auth-entry" type="submit">Reset password and sign in</button>
          </form>
        </div>
        <p class="inline-status" id="account-status" role="status" aria-live="polite"></p>
        <div class="device-approval" id="device-approval" hidden>
          <strong>Approve this device</strong>
          <p>Open the address below in a browser and enter this one-time code:</p>
          <div class="device-code" id="device-code"></div>
          <div class="device-url" id="device-url"></div>
          <div class="actions">
            <button class="secondary" id="copy-device-button" type="button">Copy address and code</button>
          </div>
        </div>
        <p class="privacy-note">Signing in connects your identity and devices. It does not upload Local Workspace content.</p>
      </section>
      <section class="failure-sheet" id="failure-sheet" role="region" aria-labelledby="failure-title"${initialFailure ? "" : " hidden"}>
        <div class="failure-header">
          <div class="failure-mark" aria-hidden="true">${brandMark}</div>
          <div>
            <h1 id="failure-title" tabindex="-1">Rudder could not start</h1>
            <p class="failure-summary" id="failure-summary" role="alert">The local runtime did not start cleanly.</p>
          </div>
        </div>
        <div class="actions">
          <button class="primary" id="retry-button" type="button">Try again</button>
          <button class="secondary" id="email-button" type="button">Email support</button>
          <button class="secondary" id="issue-button" type="button">Report on GitHub</button>
        </div>
        <div class="support-guide">
          <strong>Choose a support path</strong>
          <dl class="report-paths">
            <dt>Email support</dt>
            <dd>Opens an editable draft. Rudder adds the failure ID, time, version, system, startup stage, category, attempt, profile, and instance.</dd>
            <dt>GitHub Issue</dt>
            <dd>Opens a public bug form. Use <b>Copy diagnostic</b> below and paste it into <b>Environment details</b>.</dd>
          </dl>
          <strong class="report-checklist-title">A useful report includes</strong>
          <ol>
            <li>A one- or two-sentence summary of what broke and who is blocked.</li>
            <li>The smallest numbered steps that reproduce the failure.</li>
            <li>What happened, and what you expected instead.</li>
            <li>When it began and what changed beforehand, such as an install, update, configuration, or system change.</li>
            <li>Whether <b>Try again</b> changed the result.</li>
            <li>Your workflow impact, severity, and any workaround.</li>
            <li>A screenshot or only the relevant log lines, after reviewing them for private data.</li>
          </ol>
          <p class="privacy-note"><strong>Review before sharing.</strong> Remove API keys, tokens, cookies, passwords, private URLs, prompts, command output, and private paths. Do not attach .env, config.json, databases, credentials, or private workspace files.</p>
        </div>
        <details id="technical-details">
          <summary>Technical details</summary>
          <dl class="diagnostic-grid" id="diagnostic-grid"></dl>
          <div class="technical-actions">
            <button class="tertiary" id="copy-diagnostic-button" type="button">Copy diagnostic</button>
            <button class="tertiary" id="open-instance-button" type="button">Open data folder</button>
          </div>
        </details>
        <p class="inline-status" id="inline-status" role="status" aria-live="polite"></p>
        <div class="fallback-actions" id="fallback-actions" hidden>
          <button class="tertiary" id="copy-email-button" type="button" hidden>Copy support email</button>
          <button class="tertiary" id="copy-issue-button" type="button" hidden>Copy issue link</button>
        </div>
      </section>
    </main>
    <script>
      const bootShell = document.getElementById("boot-shell");
      const loadingView = document.getElementById("loading-view");
      const failureSheet = document.getElementById("failure-sheet");
      const accountSheet = document.getElementById("account-sheet");
      const accountTitle = document.getElementById("account-title");
      const authEntryButtons = Array.from(document.querySelectorAll(".auth-entry"));
      const googleSignInButton = document.getElementById("google-sign-in-button");
      const githubSignInButton = document.getElementById("github-sign-in-button");
      const emailSignInForm = document.getElementById("email-sign-in-form");
      const emailCodeSubmitButton = document.getElementById("email-code-submit-button");
      const emailCodeForm = document.getElementById("email-code-form");
      const accountEmail = document.getElementById("account-email");
      const accountEmailCode = document.getElementById("account-email-code");
      const emailCodeBackButton = document.getElementById("email-code-back-button");
      const passwordModeToggle = document.getElementById("password-mode-toggle");
      const passwordPanel = document.getElementById("password-panel");
      const passwordSignInForm = document.getElementById("password-sign-in-form");
      const accountPassword = document.getElementById("account-password");
      const passwordResetButton = document.getElementById("password-reset-button");
      const passwordResetForm = document.getElementById("password-reset-form");
      const passwordResetCode = document.getElementById("password-reset-code");
      const newPassword = document.getElementById("new-password");
      const accountStatus = document.getElementById("account-status");
      const deviceApproval = document.getElementById("device-approval");
      const deviceCode = document.getElementById("device-code");
      const deviceUrl = document.getElementById("device-url");
      const copyDeviceButton = document.getElementById("copy-device-button");
      const failureTitle = document.getElementById("failure-title");
      const failureSummary = document.getElementById("failure-summary");
      const diagnosticGrid = document.getElementById("diagnostic-grid");
      const technicalDetails = document.getElementById("technical-details");
      const retryButton = document.getElementById("retry-button");
      const emailButton = document.getElementById("email-button");
      const issueButton = document.getElementById("issue-button");
      const copyDiagnosticButton = document.getElementById("copy-diagnostic-button");
      const openInstanceButton = document.getElementById("open-instance-button");
      const inlineStatus = document.getElementById("inline-status");
      const fallbackActions = document.getElementById("fallback-actions");
      const copyEmailButton = document.getElementById("copy-email-button");
      const copyIssueButton = document.getElementById("copy-issue-button");
      let latestState = ${initialStateJson};
      let failureWasVisible = false;
      let viewGeneration = 0;
      let latestDeviceApproval = null;
      passwordPanel.hidden = true;

      function syncFallbackActions() {
        fallbackActions.hidden = copyEmailButton.hidden && copyIssueButton.hidden;
      }

      function renderDiagnostic(state) {
        diagnosticGrid.replaceChildren();
        const entries = [
          ["Failure ID", state.failure?.id],
          ["Occurred at", state.failure?.occurredAt],
          ["Stage", state.failure?.stage || state.stage],
          ["Attempt", state.failure?.attempt],
          ["Category", state.failure?.category],
          ["Summary", state.failure?.summary],
          ["Profile", state.runtime?.profile],
          ["Instance", state.runtime?.instance],
          ["Version", state.runtime?.version],
          ["Instance folder", state.instanceRoot],
        ].filter((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== "");
        for (const [label, value] of entries) {
          const term = document.createElement("dt");
          const detail = document.createElement("dd");
          term.textContent = String(label);
          detail.textContent = String(value);
          diagnosticGrid.append(term, detail);
        }
        openInstanceButton.hidden = !state.instanceRoot;
      }

      function applyState(state) {
        const stateIdentityChanged = (
          latestState?.view !== state?.view
          || latestState?.failure?.id !== state?.failure?.id
        );
        if (stateIdentityChanged) viewGeneration += 1;
        latestState = state;
        const failed = state?.view === "failed";
        const accountRequired = state?.view === "account_required";
        document.body.dataset.bootView = failed ? "failed" : accountRequired ? "account_required" : "loading";
        document.body.dataset.stage = state?.stage || "starting";
        bootShell.setAttribute("aria-busy", failed || accountRequired ? "false" : "true");
        loadingView.hidden = failed || accountRequired;
        failureSheet.hidden = !failed;
        accountSheet.hidden = !accountRequired;
        if (accountRequired) {
          for (const button of authEntryButtons) button.disabled = false;
          accountStatus.textContent = "";
          requestAnimationFrame(() => accountTitle.focus({ preventScroll: true }));
          return;
        }
        if (!failed) {
          failureWasVisible = false;
          inlineStatus.textContent = "";
          technicalDetails.open = false;
          retryButton.disabled = false;
          emailButton.disabled = false;
          issueButton.disabled = false;
          copyEmailButton.hidden = true;
          copyIssueButton.hidden = true;
          syncFallbackActions();
          return;
        }
        failureSummary.textContent = state.failure?.summary || "The local runtime did not start cleanly.";
        renderDiagnostic(state);
        if (!failureWasVisible) {
          failureWasVisible = true;
          requestAnimationFrame(() => failureTitle.focus({ preventScroll: true }));
        }
      }

      function requiredEmail() {
        const email = accountEmail.value.trim();
        if (!accountEmail.checkValidity()) {
          accountEmail.reportValidity();
          return null;
        }
        return email;
      }

      async function startSignIn(method, pendingMessage, email) {
        if (authEntryButtons.some((button) => button.disabled)) return;
        for (const button of authEntryButtons) button.disabled = true;
        latestDeviceApproval = null;
        deviceApproval.hidden = true;
        accountStatus.textContent = pendingMessage;
        try {
          const state = await window.rudderBoot.signIn({
            method,
            ...(email ? { email } : {}),
          });
          if (state?.status === "error") {
            accountStatus.textContent = state.message || "Rudder Account sign-in failed.";
            for (const button of authEntryButtons) button.disabled = false;
          } else {
            accountStatus.textContent = "Signed in. Opening your Local Workspace…";
          }
        } catch {
          accountStatus.textContent = "Rudder Account sign-in could not start.";
          for (const button of authEntryButtons) button.disabled = false;
        }
      }

      function setAuthBusy(busy) {
        for (const button of authEntryButtons) button.disabled = busy;
      }

      async function completeNativeSignIn(request, pendingMessage) {
        if (authEntryButtons.some((button) => button.disabled)) return;
        setAuthBusy(true);
        deviceApproval.hidden = true;
        accountStatus.textContent = pendingMessage;
        try {
          const state = await request();
          if (state?.status === "error") {
            accountStatus.textContent = state.message || "Rudder Account sign-in failed.";
            setAuthBusy(false);
          } else {
            accountStatus.textContent = "Signed in. Opening your Local Workspace…";
          }
        } catch (error) {
          accountStatus.textContent = error?.message || "Rudder Account sign-in could not start.";
          setAuthBusy(false);
        }
      }

      googleSignInButton.addEventListener("click", () => {
        void startSignIn("google", "Opening Google sign-in in your browser…");
      });
      githubSignInButton.addEventListener("click", () => {
        void startSignIn("github", "Opening GitHub sign-in in your browser…");
      });
      emailSignInForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (passwordModeToggle.getAttribute("aria-expanded") === "true") {
          accountPassword.focus();
          return;
        }
        if (!emailSignInForm.reportValidity()) return;
        if (authEntryButtons.some((button) => button.disabled)) return;
        setAuthBusy(true);
        accountStatus.textContent = "Sending a verification code…";
        void window.rudderBoot.sendEmailOtp(accountEmail.value.trim()).then(() => {
          emailSignInForm.hidden = true;
          emailCodeForm.hidden = false;
          accountStatus.textContent = "Enter the code sent to " + accountEmail.value.trim() + ".";
          setAuthBusy(false);
          accountEmailCode.focus();
        }).catch((error) => {
          accountStatus.textContent = error?.message || "Rudder could not send the verification code.";
          setAuthBusy(false);
        });
      });
      emailCodeForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!emailCodeForm.reportValidity()) return;
        void completeNativeSignIn(
          () => window.rudderBoot.verifyEmailOtp(accountEmail.value.trim(), accountEmailCode.value.trim()),
          "Verifying your email code…",
        );
      });
      emailCodeBackButton.addEventListener("click", () => {
        emailCodeForm.hidden = true;
        emailSignInForm.hidden = false;
        accountEmailCode.value = "";
        accountStatus.textContent = "";
        accountEmail.focus();
      });
      passwordModeToggle.addEventListener("click", () => {
        const expanded = passwordModeToggle.getAttribute("aria-expanded") === "true";
        passwordModeToggle.setAttribute("aria-expanded", String(!expanded));
        passwordModeToggle.textContent = expanded ? "Use password instead" : "Use email code instead";
        emailCodeSubmitButton.hidden = !expanded;
        passwordPanel.hidden = expanded;
        if (!expanded) accountPassword.focus();
      });
      passwordSignInForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const email = requiredEmail();
        if (email === null || !passwordSignInForm.reportValidity()) return;
        void completeNativeSignIn(
          () => window.rudderBoot.signInWithPassword(email, accountPassword.value),
          "Signing in…",
        );
      });
      passwordResetButton.addEventListener("click", () => {
        const email = requiredEmail();
        if (email === null || authEntryButtons.some((button) => button.disabled)) return;
        setAuthBusy(true);
        accountStatus.textContent = "Sending a password reset code…";
        void window.rudderBoot.requestPasswordReset(email).then(() => {
          passwordResetForm.hidden = false;
          passwordResetButton.hidden = true;
          accountStatus.textContent = "If an account exists, a reset code was sent to " + email + ".";
          setAuthBusy(false);
          passwordResetCode.focus();
        }).catch((error) => {
          accountStatus.textContent = error?.message || "Rudder could not request a password reset.";
          setAuthBusy(false);
        });
      });
      passwordResetForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const email = requiredEmail();
        if (email === null || !passwordResetForm.reportValidity()) return;
        void completeNativeSignIn(
          () => window.rudderBoot.resetPassword(
            email,
            passwordResetCode.value.trim(),
            newPassword.value,
          ),
          "Resetting your password…",
        );
      });
      copyDeviceButton.addEventListener("click", async () => {
        if (!latestDeviceApproval) return;
        try {
          await window.rudderBoot.copyText(
            latestDeviceApproval.verificationUri + "\\nCode: " + latestDeviceApproval.userCode,
          );
          accountStatus.textContent = "Approval address and code copied.";
        } catch {
          accountStatus.textContent = "Rudder could not copy the approval details.";
        }
      });

      retryButton.addEventListener("click", async () => {
        if (retryButton.disabled) return;
        viewGeneration += 1;
        retryButton.disabled = true;
        emailButton.disabled = true;
        issueButton.disabled = true;
        inlineStatus.textContent = "Trying again…";
        try {
          await window.rudderBoot.retryStartup();
        } catch {
          inlineStatus.textContent = "Rudder could not begin another startup attempt.";
          retryButton.disabled = false;
          emailButton.disabled = false;
          issueButton.disabled = false;
        }
      });
      emailButton.addEventListener("click", async () => {
        if (emailButton.disabled) return;
        const actionGeneration = viewGeneration;
        const failureId = latestState.failure?.id;
        const actionIsCurrent = () => (
          actionGeneration === viewGeneration
          && latestState.view === "failed"
          && latestState.failure?.id === failureId
        );
        emailButton.disabled = true;
        copyEmailButton.hidden = true;
        syncFallbackActions();
        inlineStatus.textContent = "Handing the draft to your mail app…";
        try {
          await window.rudderBoot.openSupportDraft();
          if (!actionIsCurrent()) return;
          inlineStatus.textContent = "The draft was handed to your mail app. Review it before sending.";
        } catch {
          if (!actionIsCurrent()) return;
          copyEmailButton.hidden = false;
          syncFallbackActions();
          inlineStatus.textContent = "Rudder could not hand off the draft. Copy the support email and diagnostic instead.";
        } finally {
          if (actionIsCurrent()) emailButton.disabled = false;
        }
      });
      issueButton.addEventListener("click", async () => {
        if (issueButton.disabled) return;
        const actionGeneration = viewGeneration;
        const failureId = latestState.failure?.id;
        const actionIsCurrent = () => (
          actionGeneration === viewGeneration
          && latestState.view === "failed"
          && latestState.failure?.id === failureId
        );
        issueButton.disabled = true;
        copyIssueButton.hidden = true;
        syncFallbackActions();
        inlineStatus.textContent = "Opening the GitHub bug report…";
        try {
          await window.rudderBoot.openBugReport();
          if (!actionIsCurrent()) return;
          inlineStatus.textContent = "GitHub opened. Review the public issue before submitting.";
        } catch {
          if (!actionIsCurrent()) return;
          copyIssueButton.hidden = false;
          syncFallbackActions();
          inlineStatus.textContent = "Rudder could not open GitHub. Copy the issue link and open it in your browser.";
        } finally {
          if (actionIsCurrent()) issueButton.disabled = false;
        }
      });
      copyDiagnosticButton.addEventListener("click", async () => {
        try {
          await window.rudderBoot.copyDiagnostic();
          inlineStatus.textContent = "Diagnostic copied. Review it before sharing.";
        } catch {
          inlineStatus.textContent = "Rudder could not copy the diagnostic.";
        }
      });
      openInstanceButton.addEventListener("click", async () => {
        try {
          await window.rudderBoot.openInstanceFolder();
        } catch {
          inlineStatus.textContent = "Rudder could not open the data folder.";
        }
      });
      copyEmailButton.addEventListener("click", async () => {
        try {
          await window.rudderBoot.copySupportEmail();
          inlineStatus.textContent = "Support email copied.";
        } catch {
          inlineStatus.textContent = "Rudder could not copy the support email.";
        }
      });
      copyIssueButton.addEventListener("click", async () => {
        try {
          await window.rudderBoot.copyBugReportUrl();
          inlineStatus.textContent = "GitHub issue link copied.";
        } catch {
          inlineStatus.textContent = "Rudder could not copy the issue link.";
        }
      });

      applyState(latestState);
      window.rudderBoot.onState(applyState);
      window.rudderBoot.onIdentityState((state) => {
        if (state?.status === "device-authorization") {
          latestDeviceApproval = state;
          deviceCode.textContent = state.userCode;
          deviceUrl.textContent = state.verificationUri;
          deviceApproval.hidden = false;
          accountStatus.textContent = "Waiting for approval in your browser…";
          return;
        }
        if (state?.status === "error") {
          accountStatus.textContent = state.message || "Rudder Account sign-in failed.";
          for (const button of authEntryButtons) button.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}

export type RendererRecoveryReason = {
  title?: string;
  message?: string;
  detail?: string;
};

export function createRendererRecoveryScreenHtml(appName: string, reason: RendererRecoveryReason = {}): string {
  const title = escapeHtml(appName);
  const message = escapeHtml(reason.message?.trim() || "Rudder hit a UI failure.");
  const detail = escapeHtml(
    reason.detail?.trim()
      || "The local runtime may still be running. Reload the UI first; restart Rudder if the problem continues.",
  );
  const failureTitle = escapeHtml(reason.title?.trim() || "UI recovery");
  const diagnosticJson = JSON.stringify({
    title: reason.title ?? "UI recovery",
    message: reason.message ?? "Rudder hit a UI failure.",
    detail: reason.detail ?? null,
  }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #262523;
        --panel: rgba(250, 250, 248, 0.88);
        --border: rgba(94, 109, 130, 0.18);
        --text: #1f2937;
        --muted: #64748b;
        --accent: #365776;
        --danger: #912941;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --panel: rgba(38, 37, 35, 0.92);
          --border: rgba(226, 232, 240, 0.14);
          --text: #f8fafc;
          --muted: #a7b0bd;
          --accent: #9db6cc;
          --danger: #f2a3b4;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "SF Pro Display", "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
        display: grid;
        place-items: center;
      }
      main {
        width: min(680px, calc(100vw - 48px));
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--panel);
        padding: 28px;
        box-shadow: 0 32px 72px rgba(0, 0, 0, 0.24);
      }
      .eyebrow {
        color: var(--danger);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h1 {
        margin: 10px 0 0;
        font-size: 30px;
        line-height: 1.1;
      }
      p {
        margin: 12px 0 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.55;
      }
      .detail {
        margin-top: 18px;
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px 14px;
        color: var(--muted);
        font-family: ui-monospace, "SFMono-Regular", monospace;
        font-size: 12px;
        word-break: break-word;
      }
      .actions {
        margin-top: 22px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 11px 16px;
        font: inherit;
        cursor: pointer;
      }
      .primary {
        background: var(--accent);
        color: #fff;
        font-weight: 700;
      }
      .secondary {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--border);
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">${failureTitle}</div>
      <h1>${message}</h1>
      <p>${detail}</p>
      <div class="detail" id="diagnostic"></div>
      <div class="actions">
        <button class="primary" id="reload-button" type="button">Reload UI</button>
        <button class="secondary" id="restart-button" type="button">Restart Rudder</button>
        <button class="secondary" id="copy-button" type="button">Copy diagnostic</button>
      </div>
    </main>
    <script>
      const diagnostic = ${diagnosticJson};
      const diagnosticEl = document.getElementById("diagnostic");
      diagnosticEl.textContent = [diagnostic.title, diagnostic.detail].filter(Boolean).join(" · ");
      document.getElementById("reload-button").addEventListener("click", () => {
        window.desktopShell.reloadApp();
      });
      document.getElementById("restart-button").addEventListener("click", () => {
        window.desktopShell.restart();
      });
      document.getElementById("copy-button").addEventListener("click", () => {
        window.desktopShell.copyText(JSON.stringify(diagnostic, null, 2));
      });
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export type BootScreenState = {
  view: "loading" | "failed";
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
  fallback?: {
    status: "checking" | "available" | "unavailable" | "installing";
    version?: string;
    releaseUrl?: string;
  };
  instanceRoot?: string | null;
};

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
        --shell: rgba(244, 242, 238, 0.86);
        --paper: rgba(250, 248, 245, 0.97);
        --paper-solid: #faf8f5;
        --text: #20242a;
        --muted: #686e76;
        --border: rgba(47, 53, 61, 0.18);
        --border-strong: rgba(47, 53, 61, 0.34);
        --accent: #315f66;
        --accent-hover: #264d53;
        --danger: #a0444d;
        --focus: #146b75;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --shell: rgba(21, 23, 27, 0.88);
          --paper: rgba(36, 38, 42, 0.97);
          --paper-solid: #24262a;
          --text: #f3f1ed;
          --muted: #afb3ba;
          --border: rgba(235, 232, 225, 0.16);
          --border-strong: rgba(235, 232, 225, 0.32);
          --accent: #8db7b8;
          --accent-hover: #a7cbcb;
          --danger: #e39aa1;
          --focus: #9bd2d4;
        }
      }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      html { min-height: 100%; background: transparent; }
      body {
        margin: 0;
        min-height: 100vh;
        overflow: auto;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        background: var(--shell);
        color: var(--text);
        backdrop-filter: blur(36px) saturate(112%);
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
      .version-fallback { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
      .version-fallback p { margin: 0 0 10px; color: var(--muted); font-size: 13px; line-height: 1.5; }
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
        .failure-sheet { width: min(100%, 560px); padding: 20px; }
        .report-paths { grid-template-columns: 1fr; gap: 2px; }
        .report-paths dd + dt { margin-top: 6px; }
        .diagnostic-grid { grid-template-columns: 1fr; gap: 3px; }
        .diagnostic-grid dd + dt { margin-top: 7px; }
      }
      @media (prefers-contrast: more) {
        body { background: var(--paper-solid); backdrop-filter: none; }
        .brand-stage, .failure-sheet, .secondary, details, .support-guide { border-color: currentColor; }
        .failure-sheet { border-left-color: var(--danger); }
      }
      @media (forced-colors: active) {
        body, .failure-sheet { background: Canvas; color: CanvasText; backdrop-filter: none; }
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
  <body data-boot-view="${initialFailure ? "failed" : "loading"}" data-stage="${escapeHtml(initialState.stage)}">
    <main class="boot-shell" id="boot-shell" aria-busy="${initialFailure ? "false" : "true"}">
      <p class="sr-only" role="status" aria-live="polite">Rudder is opening.</p>
      <section class="loading-view" id="loading-view" aria-hidden="true"${initialFailure ? " hidden" : ""}>
        <div class="brand-stage">
          <div class="brand-mark">${brandMark}</div>
        </div>
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
        <div class="version-fallback" id="version-fallback" hidden>
          <p id="version-fallback-copy"></p>
          <button class="secondary" id="install-fallback-button" type="button">Install previous stable version</button>
        </div>
        <div class="support-guide">
          <strong>Choose a support path</strong>
          <dl class="report-paths">
            <dt>Email support</dt>
            <dd>Opens an editable draft. Rudder adds the failure ID, time, version, system, startup stage, category, attempt, profile, and instance.</dd>
            <dt>GitHub Issue</dt>
            <dd>Opens an editable public issue draft with the same bounded diagnostic. Review it before submitting.</dd>
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
      const failureTitle = document.getElementById("failure-title");
      const failureSummary = document.getElementById("failure-summary");
      const diagnosticGrid = document.getElementById("diagnostic-grid");
      const technicalDetails = document.getElementById("technical-details");
      const retryButton = document.getElementById("retry-button");
      const emailButton = document.getElementById("email-button");
      const issueButton = document.getElementById("issue-button");
      const versionFallback = document.getElementById("version-fallback");
      const versionFallbackCopy = document.getElementById("version-fallback-copy");
      const installFallbackButton = document.getElementById("install-fallback-button");
      const copyDiagnosticButton = document.getElementById("copy-diagnostic-button");
      const openInstanceButton = document.getElementById("open-instance-button");
      const inlineStatus = document.getElementById("inline-status");
      const fallbackActions = document.getElementById("fallback-actions");
      const copyEmailButton = document.getElementById("copy-email-button");
      const copyIssueButton = document.getElementById("copy-issue-button");
      let latestState = ${initialStateJson};
      let failureWasVisible = false;
      let viewGeneration = 0;

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
        document.body.dataset.bootView = failed ? "failed" : "loading";
        document.body.dataset.stage = state?.stage || "starting";
        bootShell.setAttribute("aria-busy", failed ? "false" : "true");
        loadingView.hidden = failed;
        failureSheet.hidden = !failed;
        if (!failed) {
          failureWasVisible = false;
          inlineStatus.textContent = "";
          technicalDetails.open = false;
          retryButton.disabled = false;
          emailButton.disabled = false;
          issueButton.disabled = false;
          installFallbackButton.disabled = false;
          versionFallback.hidden = true;
          copyEmailButton.hidden = true;
          copyIssueButton.hidden = true;
          syncFallbackActions();
          return;
        }
        failureSummary.textContent = state.failure?.summary || "The local runtime did not start cleanly.";
        const fallbackVersion = state.fallback?.version;
        const fallbackAvailable = state.fallback?.status === "available" && Boolean(fallbackVersion);
        versionFallback.hidden = !fallbackAvailable;
        if (fallbackAvailable) {
          versionFallbackCopy.textContent = "This version could not start on this computer. Rudder can install the recommended previous stable release v" + String(fallbackVersion).replace(/^v/, "") + ".";
          installFallbackButton.textContent = "Install v" + String(fallbackVersion).replace(/^v/, "");
          installFallbackButton.disabled = false;
        }
        renderDiagnostic(state);
        if (!failureWasVisible) {
          failureWasVisible = true;
          requestAnimationFrame(() => failureTitle.focus({ preventScroll: true }));
        }
      }

      retryButton.addEventListener("click", async () => {
        if (retryButton.disabled) return;
        viewGeneration += 1;
        retryButton.disabled = true;
        emailButton.disabled = true;
        issueButton.disabled = true;
        installFallbackButton.disabled = true;
        inlineStatus.textContent = "Trying again…";
        try {
          await window.rudderBoot.retryStartup();
        } catch {
          inlineStatus.textContent = "Rudder could not begin another startup attempt.";
          retryButton.disabled = false;
          emailButton.disabled = false;
          issueButton.disabled = false;
          installFallbackButton.disabled = false;
        }
      });
      installFallbackButton.addEventListener("click", async () => {
        if (installFallbackButton.disabled || latestState.fallback?.status !== "available") return;
        const fallbackVersion = latestState.fallback?.version;
        installFallbackButton.disabled = true;
        inlineStatus.textContent = "Preparing the recommended previous version…";
        try {
          await window.rudderBoot.installFallback();
          inlineStatus.textContent = fallbackVersion
            ? "Installing v" + String(fallbackVersion).replace(/^v/, "") + ". Rudder will reopen automatically."
            : "Installing the previous stable version. Rudder will reopen automatically.";
        } catch {
          installFallbackButton.disabled = false;
          inlineStatus.textContent = "Rudder could not begin the fallback install. Try again or use Email support.";
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

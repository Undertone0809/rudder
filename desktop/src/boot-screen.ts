function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function createBootScreenHtml(appName: string): string {
  const title = escapeHtml(appName);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: transparent;
        --panel: rgba(249, 250, 251, 0.74);
        --panel-strong: rgba(245, 247, 249, 0.84);
        --inset: rgba(236, 240, 244, 0.72);
        --border: rgba(94, 109, 130, 0.16);
        --text: #1f2937;
        --muted: #5f6b7c;
        --accent: #4d6f8f;
        --accent-strong: #365776;
        --danger: #b6425a;
        --danger-strong: #912941;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "SF Pro Display", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(77, 111, 143, 0.1), transparent 32%),
          radial-gradient(circle at bottom right, rgba(181, 142, 92, 0.06), transparent 28%);
        color: var(--text);
        display: grid;
        place-items: center;
      }
      .shell {
        width: min(720px, calc(100vw - 48px));
        border: 1px solid var(--border);
        border-radius: 18px;
        background: var(--panel);
        backdrop-filter: blur(30px) saturate(124%);
        padding: 28px;
        box-shadow:
          0 32px 72px rgba(31, 41, 55, 0.12),
          inset 0 1px 0 rgba(255, 255, 255, 0.5);
      }
      h1 {
        margin: 0;
        font-size: 30px;
        line-height: 1.1;
      }
      p {
        margin: 10px 0 0;
        color: var(--muted);
        font-size: 14px;
      }
      .status {
        margin-top: 22px;
        padding: 18px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, var(--panel-strong) 0%, rgba(240, 244, 248, 0.76) 100%);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.58);
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(77, 111, 143, 0.12);
        color: var(--accent-strong);
        font-size: 12px;
        letter-spacing: 0.02em;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: currentColor;
      }
      .message {
        margin-top: 16px;
        font-size: 22px;
        font-weight: 600;
      }
      .detail {
        margin-top: 10px;
        color: var(--muted);
        font-size: 14px;
      }
      .error {
        color: var(--danger-strong);
      }
      .paths {
        margin-top: 18px;
        display: grid;
        gap: 10px;
      }
      .meta {
        margin-top: 18px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
      }
      .meta-row,
      .path-row {
        display: grid;
        gap: 6px;
        padding: 12px 14px;
        border-radius: 14px;
        background: var(--inset);
        border: 1px solid rgba(94, 109, 130, 0.14);
      }
      .meta-row {
        border-color: rgba(77, 111, 143, 0.16);
      }
      .meta-label,
      .path-label {
        font-size: 11px;
        letter-spacing: 0.02em;
        color: var(--muted);
      }
      .meta-value,
      .path-value {
        font-family: ui-monospace, "SFMono-Regular", monospace;
        font-size: 12px;
        word-break: break-all;
      }
      .actions {
        margin-top: 20px;
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        font: inherit;
        cursor: pointer;
        transition: transform 0.15s ease, opacity 0.15s ease;
      }
      button:hover { transform: translateY(-1px); }
      .primary {
        background: linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%);
        color: #f8f6f3;
        font-weight: 700;
      }
      .secondary {
        background: rgba(255, 255, 255, 0.58);
        color: var(--text);
        border: 1px solid var(--border);
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="pill"><span class="dot"></span><span id="phase-label">Starting</span></div>
      <h1>${title}</h1>
      <p>Local-first control plane for agent work.</p>
      <section class="status">
        <div class="message" id="message">Starting local Rudder services…</div>
        <div class="detail" id="detail">Preparing the embedded database and board UI.</div>
        <div class="detail error" id="error" hidden></div>
        <div class="meta" id="meta" hidden></div>
        <div class="paths" id="paths" hidden></div>
        <div class="actions" id="actions" hidden>
          <button class="primary" id="restart-button" type="button">Restart Rudder</button>
          <button class="secondary" id="open-home-button" type="button">Open data folder</button>
          <button class="secondary" id="copy-home-button" type="button">Copy data path</button>
        </div>
      </section>
    </main>
    <script>
      const phaseLabel = document.getElementById("phase-label");
      const messageEl = document.getElementById("message");
      const detailEl = document.getElementById("detail");
      const errorEl = document.getElementById("error");
      const metaEl = document.getElementById("meta");
      const pathsEl = document.getElementById("paths");
      const actionsEl = document.getElementById("actions");
      const restartButton = document.getElementById("restart-button");
      const openHomeButton = document.getElementById("open-home-button");
      const copyHomeButton = document.getElementById("copy-home-button");

      let latestState = null;

      function renderMeta(state) {
        metaEl.innerHTML = "";
        const entries = [
          ["Profile", state?.runtime?.localEnv],
          ["Instance", state?.runtime?.instanceId],
          ["Runtime", state?.runtime?.mode],
          ["Owner", state?.runtime?.ownerKind],
          ["Version", state?.runtime?.version],
        ].filter((entry) => Boolean(entry[1]));
        if (entries.length === 0) {
          metaEl.hidden = true;
          return;
        }
        for (const [label, value] of entries) {
          const row = document.createElement("div");
          row.className = "meta-row";
          row.innerHTML = '<div class="meta-label"></div><div class="meta-value"></div>';
          row.querySelector(".meta-label").textContent = label;
          row.querySelector(".meta-value").textContent = value;
          metaEl.appendChild(row);
        }
        metaEl.hidden = false;
      }

      function renderPaths(paths) {
        pathsEl.innerHTML = "";
        const entries = [
          ["Data home", paths?.homeDir],
          ["Instance root", paths?.instanceRoot],
          ["Config", paths?.configPath],
          ["Env file", paths?.envPath],
        ].filter((entry) => Boolean(entry[1]));
        if (entries.length === 0) {
          pathsEl.hidden = true;
          return;
        }
        for (const [label, value] of entries) {
          const row = document.createElement("div");
          row.className = "path-row";
          row.innerHTML = '<div class="path-label"></div><div class="path-value"></div>';
          row.querySelector(".path-label").textContent = label;
          row.querySelector(".path-value").textContent = value;
          pathsEl.appendChild(row);
        }
        pathsEl.hidden = false;
      }

      function applyState(state) {
        latestState = state;
        phaseLabel.textContent = state.stage === "error" ? "Startup failed" : state.stage.replaceAll("_", " ");
        messageEl.textContent = state.message || "Starting local Rudder services…";
        detailEl.textContent = state.detail || "Preparing the embedded database and board UI.";
        const failed = state.stage === "error";
        errorEl.hidden = !failed;
        errorEl.textContent = failed ? (state.error || "Rudder failed to start.") : "";
        actionsEl.hidden = !failed;
        renderMeta(state);
        renderPaths(state.paths || null);
      }

      restartButton.addEventListener("click", () => {
        window.desktopShell.restart();
      });
      openHomeButton.addEventListener("click", () => {
        if (latestState?.paths?.instanceRoot) window.desktopShell.openPath(latestState.paths.instanceRoot);
      });
      copyHomeButton.addEventListener("click", () => {
        if (latestState?.paths?.instanceRoot) window.desktopShell.copyText(latestState.paths.instanceRoot);
      });

      window.desktopShell.onBootState(applyState);
      window.desktopShell.getBootState().then(applyState);
    </script>
  </body>
</html>`;
}

const COMPARE_STORAGE_KEY = "run-intelligence.compare-selection";

const state = {
  runs: [],
  detailByRunId: {},
  loadingPanels: new Set(),
  refreshingPanels: new Set(),
  refreshingWorkspace: false,
  compareRunIds: loadCompareSelection(),
};

const pageBody = document.getElementById("pageBody");
const pageTitle = document.getElementById("pageTitle");
const pageSubtitle = document.getElementById("pageSubtitle");
const selectionBar = document.getElementById("selectionBar");
const refreshButton = document.getElementById("refreshButton");
const runsHomeLink = document.getElementById("runsHomeLink");

function loadCompareSelection() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COMPARE_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function persistCompareSelection() {
  window.localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(state.compareRunIds));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value, maxLength = 180) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatDate(value) {
  if (!value) return "N/A";
  return new Date(value).toLocaleString();
}

function formatDurationFromMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "N/A";
  const totalSeconds = Math.round(durationMs / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}m ${secs}s`;
}

function getDurationMs(run) {
  const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
  if (startedAt && finishedAt && finishedAt >= startedAt) {
    return finishedAt - startedAt;
  }
  return 0;
}

function formatTokensAndCost(run) {
  const usage = run.usageJson || {};
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cost = usage.costUsd ?? 0;
  return `${Number(input).toLocaleString()}/${Number(output).toLocaleString()} | $${Number(cost).toFixed(2)}`;
}

function routeFromLocation() {
  const path = window.location.pathname;
  const compareMatch = path === "/compare";
  if (compareMatch) {
    const runIds = new URLSearchParams(window.location.search).get("runs")?.split(",").filter(Boolean) ?? state.compareRunIds;
    return { name: "compare", runIds };
  }
  const detailMatch = path.match(/^\/runs\/([^/]+)$/);
  if (detailMatch) {
    return { name: "detail", runId: decodeURIComponent(detailMatch[1]) };
  }
  return { name: "runs" };
}

function buildCompareHref(runIds) {
  const qs = new URLSearchParams();
  if (runIds.length > 0) qs.set("runs", runIds.join(","));
  const query = qs.toString();
  return query ? `/compare?${query}` : "/compare";
}

function navigateTo(path, { replace = false } = {}) {
  window.history[replace ? "replaceState" : "pushState"]({}, "", path);
  renderApp();
  void ensureRouteData();
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json();
}

async function postJson(url, body) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function getRunSummary(runId) {
  return state.runs.find((summary) => summary.row.run.id === runId) ?? null;
}

function getRunLabel(runId) {
  const summary = getRunSummary(runId);
  const payload = state.detailByRunId[runId];
  return summary?.row.agentName || payload?.detail.agentName || payload?.detail.run.agentId || runId;
}

function currentVisibleRunIds() {
  const route = routeFromLocation();
  if (route.name === "detail") return [route.runId];
  if (route.name === "compare") return route.runIds;
  return [];
}

async function loadOrganizationsMarkup() {
  const organizations = await fetchJson("/api/organizations");
  return `<option value="">All orgs</option>${organizations.map((org) => `<option value="${escapeHtml(org.id)}">${escapeHtml(org.name)}</option>`).join("")}`;
}

function getFilterValues() {
  return {
    org: document.getElementById("orgFilter")?.value ?? "",
    agent: document.getElementById("agentFilter")?.value ?? "",
    status: document.getElementById("statusFilter")?.value ?? "",
    runtime: document.getElementById("runtimeFilter")?.value ?? "",
    issue: document.getElementById("issueFilter")?.value ?? "",
    startedAfter: document.getElementById("startedAfterFilter")?.value ?? "",
    startedBefore: document.getElementById("startedBeforeFilter")?.value ?? "",
  };
}

function filteredRuns() {
  const filters = getFilterValues();
  const startedAfter = filters.startedAfter ? new Date(filters.startedAfter).getTime() : null;
  const startedBefore = filters.startedBefore ? new Date(filters.startedBefore).getTime() : null;

  return state.runs.filter((summary) => {
    const run = summary.row.run;
    const startedAtMs = new Date(run.startedAt || run.createdAt).getTime();
    const orgMatches = !filters.org || run.orgId === filters.org;
    const agentMatches = !filters.agent || `${summary.row.agentName || ""} ${run.agentId}`.toLowerCase().includes(filters.agent.toLowerCase());
    const statusMatches = !filters.status || run.status.toLowerCase().includes(filters.status.toLowerCase());
    const runtimeMatches = !filters.runtime || summary.row.bundle.agentRuntimeType.toLowerCase().includes(filters.runtime.toLowerCase());
    const issueText = `${summary.row.issue?.identifier || ""} ${summary.row.issue?.title || ""}`.toLowerCase();
    const issueMatches = !filters.issue || issueText.includes(filters.issue.toLowerCase());
    const afterMatches = startedAfter === null || startedAtMs >= startedAfter;
    const beforeMatches = startedBefore === null || startedAtMs <= startedBefore;
    return orgMatches && agentMatches && statusMatches && runtimeMatches && issueMatches && afterMatches && beforeMatches;
  });
}

async function loadRuns() {
  const rows = await fetchJson("/api/runs");
  state.runs = rows.sort((left, right) => new Date(right.row.run.createdAt).getTime() - new Date(left.row.run.createdAt).getTime());
}

function metadataCards(detail, diagnosis) {
  const metrics = diagnosis.metrics || {};
  const items = [
    ["Run ID", detail.run.id],
    ["Org", detail.orgName || detail.run.orgId],
    ["Agent", detail.agentName || detail.run.agentId],
    ["Issue", detail.issue?.identifier || detail.issue?.title || "No linked issue"],
    ["Runtime", detail.bundle.agentRuntimeType],
    ["Config revision", detail.bundle.agentConfigRevisionId || "N/A"],
    ["Agent config fp", detail.bundle.agentConfigFingerprint || "N/A"],
    ["Runtime config fp", detail.bundle.runtimeConfigFingerprint || "N/A"],
    ["Started", formatDate(detail.run.startedAt || detail.run.createdAt)],
    ["Finished", formatDate(detail.run.finishedAt)],
    ["Duration", formatDurationFromMs(metrics.durationMs || getDurationMs(detail.run))],
    ["Tokens / Cost", `${Number(metrics.inputTokens || 0).toLocaleString()}/${Number(metrics.outputTokens || 0).toLocaleString()} | $${Number(metrics.costUsd || 0).toFixed(2)}`],
  ];

  return `
    <div class="metadata-grid">
      ${items.map(([label, value]) => `
        <div class="metadata-item">
          <span class="metadata-label">${escapeHtml(label)}</span>
          <span class="metadata-value">${escapeHtml(value)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function compareFactsCard(detail, diagnosis) {
  const metrics = diagnosis.metrics || {};
  const items = [
    ["Run ID", detail.run.id],
    ["Org", detail.orgName || detail.run.orgId],
    ["Agent", detail.agentName || detail.run.agentId],
    ["Runtime", detail.bundle.agentRuntimeType],
    ["Created", formatDate(detail.run.createdAt || detail.run.startedAt)],
    ["Duration", formatDurationFromMs(metrics.durationMs || getDurationMs(detail.run))],
    [
      "Tokens / Cost",
      `${Number(metrics.inputTokens || 0).toLocaleString()}/${Number(metrics.outputTokens || 0).toLocaleString()} | $${Number(metrics.costUsd || 0).toFixed(2)}`,
    ],
  ];

  return `
    <section class="compare-facts-card">
      <div class="compare-section-head">
        <h4>Run Facts</h4>
      </div>
      <div class="compare-facts-grid">
        ${items.map(([label, value]) => `
          <div class="compare-fact-item">
            <span class="metadata-label">${escapeHtml(label)}</span>
            <span class="metadata-value">${escapeHtml(value)}</span>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderTraceStep(step) {
  const classes = ["trace-step"];
  if (step.isPayloadEntry) classes.push("payload");
  if (step.isError) classes.push("error");

  if (step.hasExpandableDetail) {
    return `
      <details class="${classes.join(" ")}">
        <summary>
          <div class="step-meta">
            <span class="turn-tag">#${escapeHtml(step.index)}</span>
            <span class="turn-kind">${escapeHtml(step.kind)}</span>
            <span class="turn-ts">${escapeHtml(formatDate(step.ts))}</span>
            <span class="step-expand">Expand detail</span>
          </div>
          <div class="turn-preview">${escapeHtml(step.detailPreview || "(empty)")}</div>
        </summary>
        <div class="step-detail">
          <pre>${escapeHtml(step.detailText || "(no detail)")}</pre>
        </div>
      </details>
    `;
  }

  return `
    <div class="${classes.join(" ")} static">
      <div class="step-meta">
        <span class="turn-tag">#${escapeHtml(step.index)}</span>
        <span class="turn-kind">${escapeHtml(step.kind)}</span>
        <span class="turn-ts">${escapeHtml(formatDate(step.ts))}</span>
      </div>
      <div class="turn-preview">${escapeHtml(step.detailPreview || "(empty)")}</div>
    </div>
  `;
}

function renderTranscript(trace) {
  if (!trace || trace.steps.length === 0) {
    return `<div class="empty-inline muted">No transcript entries were parsed for this run.</div>`;
  }

  const contextMarkup = trace.looseSteps.length > 0 ? `
    <details class="turn-group context">
      <summary>
        <div class="turn-group-meta">
          <span class="turn-tag">Context</span>
          <span class="turn-ts">${escapeHtml(`${trace.looseSteps.length} setup step${trace.looseSteps.length === 1 ? "" : "s"}`)}</span>
        </div>
        <div class="turn-preview">Boot metadata, system output, and non-turn transcript entries.</div>
      </summary>
      <div class="turn-steps">
        ${trace.looseSteps.map((step) => renderTraceStep(step)).join("")}
      </div>
    </details>
  ` : "";

  const turnMarkup = trace.turns.map((turn, index) => `
    <details class="turn-group ${turn.hasError ? "error" : ""}" ${index === 0 ? "open" : ""}>
      <summary>
        <div class="turn-group-meta">
          <span class="turn-tag">${escapeHtml(turn.label)}</span>
          <span class="turn-kind">${escapeHtml(`${turn.stepCount} steps`)}</span>
          <span class="turn-kind">${escapeHtml(`${turn.toolCallCount} tools`)}</span>
          <span class="turn-ts">${escapeHtml(formatDate(turn.startedAt))}</span>
        </div>
        <div class="turn-preview">${escapeHtml(turn.summary || "No summary")}</div>
      </summary>
      <div class="turn-steps">
        ${turn.steps.map((step) => renderTraceStep(step)).join("")}
      </div>
    </details>
  `).join("");

  return `<div class="timeline">${contextMarkup}${turnMarkup}</div>`;
}

function renderEvents(detail) {
  if (!detail.events?.length) return `<div class="empty-inline muted">No event records captured for this run.</div>`;
  return `
    <div class="event-list">
      ${detail.events.map((event) => `
        <div class="event-row">
          <div class="event-head">
            <span class="turn-tag">#${escapeHtml(event.seq)}</span>
            <span class="turn-kind">${escapeHtml(event.eventType)}</span>
            <span class="turn-ts">${escapeHtml(formatDate(event.createdAt))}</span>
          </div>
          <div class="event-message">${escapeHtml(event.message || "")}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderSelectionBar() {
  if (state.compareRunIds.length === 0) {
    selectionBar.innerHTML = "";
    selectionBar.className = "selection-bar hidden";
    return;
  }

  selectionBar.className = "selection-bar";
  selectionBar.innerHTML = `
    <div class="selection-copy">
      <strong>${escapeHtml(String(state.compareRunIds.length))} queued for compare</strong>
      <span class="muted">Compare is a dedicated page so each run keeps usable reading width.</span>
    </div>
    <div class="selection-list">
      ${state.compareRunIds.map((runId) => `
        <div class="selection-chip">
          <span>${escapeHtml(getRunLabel(runId))}</span>
          <code>${escapeHtml(runId.slice(0, 8))}</code>
          <button class="chip-dismiss" data-remove-compare="${escapeHtml(runId)}">Remove</button>
        </div>
      `).join("")}
    </div>
    <div class="selection-actions">
      <a class="button" href="${escapeHtml(buildCompareHref(state.compareRunIds))}" data-open-compare>Open Compare</a>
      <button class="button subtle-button" id="clearCompareButton">Clear Queue</button>
    </div>
  `;

  for (const button of selectionBar.querySelectorAll("[data-remove-compare]")) {
    button.addEventListener("click", () => {
      toggleCompareSelection(button.getAttribute("data-remove-compare"), false);
    });
  }
  selectionBar.querySelector("#clearCompareButton")?.addEventListener("click", () => {
    state.compareRunIds = [];
    persistCompareSelection();
    renderSelectionBar();
    if (routeFromLocation().name === "compare") {
      navigateTo("/", { replace: true });
    } else {
      renderApp();
    }
  });
  selectionBar.querySelector("[data-open-compare]")?.addEventListener("click", (event) => {
    event.preventDefault();
    navigateTo(buildCompareHref(state.compareRunIds));
  });
}

function renderRunTable() {
  const rows = filteredRuns();
  return `
    <div class="panel runs-page-panel">
      <div class="panel-header">
        <div>
          <h2>Runs</h2>
          <p class="muted panel-copy">Open takes you to a dedicated detail page. Compare queues runs for the separate compare view.</p>
        </div>
        <span class="muted">${escapeHtml(`${rows.length} runs`)}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Agent</th>
              <th>Status</th>
              <th>Issue</th>
              <th>Runtime</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Tokens/Cost</th>
              <th>Finding</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="runsTableBody">
            ${rows.map((summary) => {
              const run = summary.row.run;
              const queued = state.compareRunIds.includes(run.id);
              return `
                <tr data-open-run="${escapeHtml(run.id)}">
                  <td><code>${escapeHtml(run.id.slice(0, 8))}</code></td>
                  <td>${escapeHtml(summary.row.agentName || run.agentId)}</td>
                  <td><span class="chip">${escapeHtml(run.status)}</span></td>
                  <td>${escapeHtml(`${summary.row.issue?.identifier || ""} ${summary.row.issue?.title || ""}`.trim())}</td>
                  <td>${escapeHtml(summary.row.bundle.agentRuntimeType)}</td>
                  <td>${escapeHtml(formatDate(run.startedAt || run.createdAt))}</td>
                  <td>${escapeHtml(formatDurationFromMs(getDurationMs(run)))}</td>
                  <td>${escapeHtml(formatTokensAndCost(run))}</td>
                  <td>${escapeHtml(summary.findingSummary)}</td>
                  <td class="row-actions">
                    <button class="table-action" data-open-button="${escapeHtml(run.id)}">Open</button>
                    <button class="table-action secondary" data-toggle-compare="${escapeHtml(run.id)}">${queued ? "Queued" : "Compare"}</button>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function renderRunsPage() {
  const orgOptions = await loadOrganizationsMarkup();
  pageTitle.textContent = "Runs";
  pageSubtitle.textContent = "Browse all runs, then open one in a dedicated detail view or queue several for comparison.";
  pageBody.className = "page-body runs-page";
  pageBody.innerHTML = `
    <section class="filters">
      <select id="orgFilter">${orgOptions}</select>
      <input id="agentFilter" type="text" placeholder="Filter by agent" />
      <input id="statusFilter" type="text" placeholder="Filter by status" />
      <input id="runtimeFilter" type="text" placeholder="Filter by runtime" />
      <input id="issueFilter" type="text" placeholder="Filter by issue" />
      <label class="date-filter">
        <span>From</span>
        <input id="startedAfterFilter" type="datetime-local" />
      </label>
      <label class="date-filter">
        <span>To</span>
        <input id="startedBeforeFilter" type="datetime-local" />
      </label>
    </section>
    ${renderRunTable()}
  `;

  bindRunsTableInteractions();
  bindFilters();
}

function renderPanelActions(runId) {
  const queued = state.compareRunIds.includes(runId);
  return `
    <div class="panel-controls">
      <button class="icon-button" data-toggle-compare="${escapeHtml(runId)}">${queued ? "Remove From Compare" : "Add To Compare"}</button>
      <button class="icon-button" data-refresh-panel="${escapeHtml(runId)}">Refresh</button>
    </div>
  `;
}

function renderDetailPage(runId) {
  const payload = state.detailByRunId[runId];
  pageTitle.textContent = payload ? `${getRunLabel(runId)} · Detail` : "Run Detail";
  pageSubtitle.textContent = "Single-run reading mode. This page gives the transcript enough width to inspect each turn without compare compression.";
  pageBody.className = "page-body detail-page";

  if (!payload) {
    const isLoading = state.loadingPanels.has(runId);
    pageBody.innerHTML = `
      <div class="panel detail-panel">
        <div class="detail-page-head">
          <div>
            <a class="back-link" href="/" data-back-runs>← Back to runs</a>
            <h2>${escapeHtml(runId.slice(0, 8))}</h2>
          </div>
          ${renderPanelActions(runId)}
        </div>
        <div class="empty-state">
          <h3>${isLoading ? "Loading run detail" : "Run detail unavailable"}</h3>
          <p class="muted">${isLoading ? "Fetching detail and normalized transcript…" : "This run detail has not loaded yet."}</p>
        </div>
      </div>
    `;
    bindDetailPageInteractions(runId);
    return;
  }

  const { detail, diagnosis, trace, lastSyncedAt } = payload;
  pageBody.innerHTML = `
    <div class="panel detail-panel">
      <div class="detail-page-head">
        <div class="detail-title-stack">
          <a class="back-link" href="/" data-back-runs>← Back to runs</a>
          <div class="detail-headline-row">
            <h2>${escapeHtml(getRunLabel(runId))}</h2>
            <span class="chip">${escapeHtml(detail.run.status)}</span>
            <span class="chip">${escapeHtml(diagnosis.failureTaxonomy)}</span>
          </div>
          <p class="muted"><code>${escapeHtml(detail.run.id)}</code> · ${escapeHtml(detail.bundle.agentRuntimeType)} · synced ${escapeHtml(formatDate(lastSyncedAt))}</p>
        </div>
        ${renderPanelActions(runId)}
      </div>

      <div class="detail-page-grid">
        <section class="detail-main">
          <div class="detail-section">
            <h3>Summary</h3>
            <p class="summary">${escapeHtml(diagnosis.summary)}</p>
          </div>

          <section class="detail-section">
            <h3>Transcript Turns</h3>
            <p class="muted section-copy">The default view stays compact: every model turn is visible, but large payloads stay collapsed until you open them.</p>
            ${renderTranscript(trace)}
          </section>

          <details class="detail-block">
            <summary>Events</summary>
            ${renderEvents(detail)}
          </details>

          <details class="detail-block">
            <summary>Raw Log</summary>
            <pre>${escapeHtml(detail.logContent || "No persisted log content.")}</pre>
          </details>
        </section>

        <aside class="detail-sidebar">
          <section class="detail-section">
            <h3>Run Facts</h3>
            ${metadataCards(detail, diagnosis)}
          </section>

          <section class="detail-section">
            <h3>Findings</h3>
            ${diagnosis.findings.length
              ? diagnosis.findings.map((finding) => `
                  <div class="finding ${escapeHtml(finding.severity)}">
                    <strong>${escapeHtml(finding.title)}</strong>
                    <div>${escapeHtml(finding.detail)}</div>
                  </div>
                `).join("")
              : `<div class="empty-inline muted">No findings.</div>`}
          </section>

          <section class="detail-section">
            <h3>Next Steps</h3>
            <ul class="detail-list">
              ${diagnosis.nextSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  `;
  bindDetailPageInteractions(runId);
}

function renderCompareCard(runId) {
  const payload = state.detailByRunId[runId];
  if (!payload) {
    return `
      <article class="compare-panel">
        <div class="compare-panel-head">
          <div>
            <h3>${escapeHtml(getRunLabel(runId))}</h3>
            <p class="muted"><code>${escapeHtml(runId.slice(0, 8))}</code></p>
          </div>
          <div class="panel-controls">
            <button class="icon-button" data-remove-compare="${escapeHtml(runId)}">Remove</button>
          </div>
        </div>
        <div class="empty-inline muted">Loading run detail…</div>
      </article>
    `;
  }

  const { detail, diagnosis, trace } = payload;
  return `
    <article class="compare-panel">
      <div class="compare-panel-head">
        <div>
          <h3>${escapeHtml(getRunLabel(runId))}</h3>
          <p class="muted"><code>${escapeHtml(detail.run.id.slice(0, 8))}</code> · ${escapeHtml(detail.bundle.agentRuntimeType)}</p>
        </div>
        <div class="panel-controls">
          <button class="icon-button" data-open-detail="${escapeHtml(runId)}">Open Detail</button>
          <button class="icon-button" data-refresh-panel="${escapeHtml(runId)}">Refresh</button>
          <button class="icon-button" data-remove-compare="${escapeHtml(runId)}">Remove</button>
        </div>
      </div>

      <div class="compare-summary-grid">
        <span class="chip">${escapeHtml(detail.run.status)}</span>
        <span class="chip">${escapeHtml(diagnosis.failureTaxonomy)}</span>
        <span class="chip">${escapeHtml(formatDurationFromMs(diagnosis.metrics.durationMs || getDurationMs(detail.run)))}</span>
      </div>

      <p class="summary">${escapeHtml(diagnosis.summary)}</p>

      ${compareFactsCard(detail, diagnosis)}

      <section class="detail-section">
        <h4>Findings</h4>
        ${diagnosis.findings.length
          ? diagnosis.findings.map((finding) => `
              <div class="finding ${escapeHtml(finding.severity)}">
                <strong>${escapeHtml(finding.title)}</strong>
                <div>${escapeHtml(finding.detail)}</div>
              </div>
            `).join("")
          : `<div class="empty-inline muted">No findings.</div>`}
      </section>

      <section class="detail-section">
        <h4>Turn Outline</h4>
        ${renderTranscript(trace)}
      </section>
    </article>
  `;
}

function renderComparePage(runIds) {
  pageTitle.textContent = "Compare Runs";
  pageSubtitle.textContent = "Compare mode is its own page so each run gets enough width. Use it only when you are intentionally doing side-by-side diagnosis.";
  pageBody.className = "page-body compare-page";

  if (runIds.length === 0) {
    pageBody.innerHTML = `
      <div class="panel empty-panel">
        <div class="empty-state">
          <h3>No runs queued for compare</h3>
          <p class="muted">Go back to the runs list and queue two or more runs, then open compare.</p>
          <a class="button" href="/" data-back-runs>Back to Runs</a>
        </div>
      </div>
    `;
    pageBody.querySelector("[data-back-runs]")?.addEventListener("click", (event) => {
      event.preventDefault();
      navigateTo("/");
    });
    return;
  }

  pageBody.innerHTML = `
    <div class="compare-page-head">
      <div>
        <h2>${escapeHtml(`${runIds.length} runs in compare`)}</h2>
        <p class="muted">Use compare for cross-run diagnosis. Use single detail when you need long-form reading space.</p>
      </div>
      <div class="panel-controls">
        <a class="button subtle-button" href="/" data-back-runs>Back to Runs</a>
      </div>
    </div>
    <div class="compare-page-grid">
      ${runIds.map((runId) => renderCompareCard(runId)).join("")}
    </div>
  `;

  pageBody.querySelector("[data-back-runs]")?.addEventListener("click", (event) => {
    event.preventDefault();
    navigateTo("/");
  });

  for (const button of pageBody.querySelectorAll("[data-open-detail]")) {
    button.addEventListener("click", () => {
      const runId = button.getAttribute("data-open-detail");
      navigateTo(`/runs/${encodeURIComponent(runId)}`);
    });
  }
  for (const button of pageBody.querySelectorAll("[data-remove-compare]")) {
    button.addEventListener("click", () => {
      toggleCompareSelection(button.getAttribute("data-remove-compare"), false);
    });
  }
  for (const button of pageBody.querySelectorAll("[data-refresh-panel]")) {
    button.addEventListener("click", () => {
      void refreshPanel(button.getAttribute("data-refresh-panel"));
    });
  }
}

function bindRunsTableInteractions() {
  for (const row of pageBody.querySelectorAll("[data-open-run]")) {
    row.addEventListener("click", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("button")) return;
      const runId = row.getAttribute("data-open-run");
      navigateTo(`/runs/${encodeURIComponent(runId)}`);
    });
  }
  for (const button of pageBody.querySelectorAll("[data-open-button]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const runId = button.getAttribute("data-open-button");
      navigateTo(`/runs/${encodeURIComponent(runId)}`);
    });
  }
  for (const button of pageBody.querySelectorAll("[data-toggle-compare]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCompareSelection(button.getAttribute("data-toggle-compare"));
    });
  }
}

function bindFilters() {
  for (const input of pageBody.querySelectorAll("select, input")) {
    input.addEventListener("input", () => {
      pageBody.querySelector(".runs-page-panel")?.replaceWith(document.createRange().createContextualFragment(renderRunTable()).firstElementChild);
      bindRunsTableInteractions();
    });
    input.addEventListener("change", () => {
      pageBody.querySelector(".runs-page-panel")?.replaceWith(document.createRange().createContextualFragment(renderRunTable()).firstElementChild);
      bindRunsTableInteractions();
    });
  }
}

function bindDetailPageInteractions(runId) {
  pageBody.querySelector("[data-back-runs]")?.addEventListener("click", (event) => {
    event.preventDefault();
    navigateTo("/");
  });
  pageBody.querySelector("[data-toggle-compare]")?.addEventListener("click", () => {
    toggleCompareSelection(runId);
  });
  pageBody.querySelector("[data-refresh-panel]")?.addEventListener("click", () => {
    void refreshPanel(runId);
  });
}

function toggleCompareSelection(runId, nextValue) {
  if (!runId) return;
  const currentlySelected = state.compareRunIds.includes(runId);
  const shouldSelect = typeof nextValue === "boolean" ? nextValue : !currentlySelected;
  if (shouldSelect && !currentlySelected) {
    state.compareRunIds = [...state.compareRunIds, runId];
  }
  if (!shouldSelect && currentlySelected) {
    state.compareRunIds = state.compareRunIds.filter((id) => id !== runId);
  }
  persistCompareSelection();
  renderSelectionBar();

  const route = routeFromLocation();
  if (route.name === "compare") {
    const nextRunIds = route.runIds.filter((id) => state.compareRunIds.includes(id));
    if (nextRunIds.length === 0) {
      navigateTo("/", { replace: true });
    } else {
      navigateTo(buildCompareHref(nextRunIds), { replace: true });
    }
    return;
  }
  renderApp();
}

async function loadRunDetail(runId, { force = false } = {}) {
  if (!runId) return;
  if (state.loadingPanels.has(runId)) return;
  if (!force && state.detailByRunId[runId]) return;

  state.loadingPanels.add(runId);
  renderApp();
  try {
    state.detailByRunId[runId] = await fetchJson(`/api/runs/${runId}`);
  } finally {
    state.loadingPanels.delete(runId);
    renderApp();
  }
}

async function refreshPanel(runId) {
  if (!runId || state.refreshingPanels.has(runId)) return;
  state.refreshingPanels.add(runId);
  renderApp();
  try {
    state.detailByRunId[runId] = await postJson(`/api/runs/${runId}/refresh`);
    await loadRuns();
  } finally {
    state.refreshingPanels.delete(runId);
    renderApp();
  }
}

async function ensureRouteData() {
  const route = routeFromLocation();
  const runIds = route.name === "detail" ? [route.runId] : route.name === "compare" ? route.runIds : [];
  await Promise.all(runIds.map((runId) => loadRunDetail(runId)));
}

async function refreshWorkspace() {
  if (state.refreshingWorkspace) return;
  state.refreshingWorkspace = true;
  renderApp();
  try {
    await postJson("/api/refresh");
    const visibleRunIds = currentVisibleRunIds();
    if (visibleRunIds.length > 0) {
      const results = await Promise.allSettled(visibleRunIds.map((runId) => postJson(`/api/runs/${runId}/refresh`)));
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          state.detailByRunId[visibleRunIds[index]] = result.value;
        }
      });
    }
  } catch (error) {
    console.warn("Failed to refresh from Rudder; falling back to cached data.", error);
  } finally {
    await loadRuns().catch(() => undefined);
    state.refreshingWorkspace = false;
    renderApp();
  }
}

async function renderApp() {
  const route = routeFromLocation();
  runsHomeLink.classList.toggle("active", route.name === "runs");
  refreshButton.textContent = state.refreshingWorkspace ? "Refreshing…" : "Refresh";
  refreshButton.disabled = state.refreshingWorkspace;
  renderSelectionBar();

  if (route.name === "runs") {
    await renderRunsPage();
    return;
  }
  if (route.name === "detail") {
    renderDetailPage(route.runId);
    return;
  }
  renderComparePage(route.runIds);
}

async function bootstrap() {
  await loadRuns();
  await refreshWorkspace();
  await ensureRouteData();
}

refreshButton.addEventListener("click", () => {
  void refreshWorkspace();
});

runsHomeLink.addEventListener("click", (event) => {
  event.preventDefault();
  navigateTo("/");
});

window.addEventListener("popstate", () => {
  renderApp();
  void ensureRouteData();
});

void bootstrap();

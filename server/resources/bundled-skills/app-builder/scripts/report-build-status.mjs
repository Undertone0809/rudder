#!/usr/bin/env node

const STATUS = process.argv[2];
const APP_ID = process.argv[3];
const ALLOWED_STATUSES = new Set(["building", "verified_source_ready", "failed"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!ALLOWED_STATUSES.has(STATUS) || !UUID_PATTERN.test(APP_ID ?? "")) {
  console.error("Usage: report-build-status.mjs <building|verified_source_ready|failed> <app-id>");
  process.exit(2);
}

const apiUrl = process.env.RUDDER_API_URL?.trim();
const apiKey = process.env.RUDDER_API_KEY?.trim();
const orgId = process.env.RUDDER_ORG_ID?.trim();
const runId = process.env.RUDDER_RUN_ID?.trim();
if (!apiUrl || !apiKey || !orgId || !runId) {
  console.error("Rudder run context is unavailable; do not report a completed App handoff.");
  process.exit(2);
}

const base = apiUrl.replace(/\/+$/u, "");
const apiBase = new URL(base).pathname.replace(/\/+$/u, "").endsWith("/api")
  ? base
  : `${base}/api`;
const endpoint = `${apiBase}/app-builder/${encodeURIComponent(APP_ID)}/build?orgId=${encodeURIComponent(orgId)}`;
const headers = {
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};
const currentResponse = await fetch(
  `${apiBase}/orgs/${encodeURIComponent(orgId)}/app-builder`,
  { headers },
);
if (!currentResponse.ok) {
  console.error(`Rudder could not read the App handoff state (${currentResponse.status}).`);
  process.exit(1);
}
const current = (await currentResponse.json()).find((app) => app.id === APP_ID);
if (!current) {
  console.error("Rudder App handoff identity was not found in this organization.");
  process.exit(1);
}
const duplicateRunId = STATUS === "verified_source_ready"
  ? current.latestVerificationRunId
  : current.latestBuildRunId;
if (current.buildStatus === STATUS && duplicateRunId === runId) {
  console.log(`App Builder status: ${current.buildStatus}`);
  process.exit(0);
}
const allowedCurrentStatuses = STATUS === "building"
  ? new Set(["preparing", "ready", "launch_failed", "failed"])
  : STATUS === "verified_source_ready"
    ? new Set(["building"])
    : new Set(["preparing", "building"]);
if (!allowedCurrentStatuses.has(current.buildStatus)) {
  console.error(
    `Rudder rejected the stale App handoff transition ${current.buildStatus} -> ${STATUS}.`,
  );
  process.exit(1);
}
const response = await fetch(
  endpoint,
  {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      status: STATUS,
      expectedStatus: current.buildStatus,
      runId,
      runKind: STATUS === "verified_source_ready" ? "verification" : "build",
    }),
  },
);

if (!response.ok) {
  const detail = await response.text();
  console.error(`Rudder rejected the App handoff (${response.status}): ${detail.slice(0, 500)}`);
  process.exit(1);
}

const app = await response.json();
console.log(`App Builder status: ${app.buildStatus}`);

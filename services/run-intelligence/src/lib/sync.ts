import { WebSocket } from "ws";
import { buildObservedRunTrace, diagnoseRun, listOrganizations, listObservedRuns, loadObservedRunDetail } from "@rudderhq/run-intelligence-core";
import type { RunExportRow } from "@rudderhq/run-intelligence-core";
import type { LiveEvent } from "@rudderhq/shared";
import { RunIntelligenceCache } from "./cache.js";

const BACKFILL_BATCH_SIZE = 400;

function summarizeRun(row: RunExportRow) {
  const usage = row.run.usageJson ?? {};
  const inputTokens = Number(usage.inputTokens ?? 0);
  const costUsd = Number(usage.costUsd ?? 0);
  if (row.run.status === "failed") return row.run.error ?? "Run failed";
  if (row.run.status === "running") return "Run in progress";
  if (costUsd > 5) return `High cost ($${costUsd.toFixed(2)})`;
  if (inputTokens > 500_000) return `High token usage (${inputTokens.toLocaleString()})`;
  return row.run.status === "succeeded" ? "Healthy" : row.run.status;
}

export class RunIntelligenceSync {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private sockets = new Map<string, WebSocket>();

  constructor(
    private readonly cache: RunIntelligenceCache,
    private readonly rudderApiUrl: string,
    private readonly syncIntervalMs: number,
  ) {}

  async start() {
    await this.synchronizeAll();
    this.intervalHandle = setInterval(() => {
      void this.synchronizeAll();
    }, this.syncIntervalMs);
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    for (const socket of this.sockets.values()) {
      socket.close();
    }
    this.sockets.clear();
  }

  async synchronizeAll() {
    const organizations = await listOrganizations(this.rudderApiUrl).catch(() => []);
    if (organizations.length === 0) return;
    await this.cache.setOrganizations(organizations);

    for (const organization of organizations) {
      await this.synchronizeOrganization(organization.id);
      this.ensureSocket(organization.id);
    }
  }

  async synchronizeOrganization(orgId: string) {
    const cursor = this.cache.getCursor(orgId);
    if (cursor) {
      const params = new URLSearchParams({
        limit: String(BACKFILL_BATCH_SIZE),
        updatedAfter: cursor,
      });
      const rows = await listObservedRuns(this.rudderApiUrl, orgId, params).catch(() => []);
      await this.ingestRows(rows);
      return;
    }

    let createdBefore: string | null = null;
    while (true) {
      const params = new URLSearchParams({ limit: String(BACKFILL_BATCH_SIZE) });
      if (createdBefore) params.set("createdBefore", createdBefore);
      const rows = await listObservedRuns(this.rudderApiUrl, orgId, params).catch(() => []);
      if (rows.length === 0) break;
      await this.ingestRows(rows);
      if (rows.length < BACKFILL_BATCH_SIZE) break;
      const lastRow = rows[rows.length - 1];
      createdBefore = lastRow?.run.createdAt ? new Date(lastRow.run.createdAt).toISOString() : null;
      if (!createdBefore) break;
    }
  }

  async refreshRunDetail(runId: string) {
    const detail = await loadObservedRunDetail(this.rudderApiUrl, runId);
    const diagnosis = diagnoseRun(detail, "full");
    const trace = buildObservedRunTrace(detail);
    await this.cache.writeRunDetail({
      detail,
      diagnosis,
      trace,
      lastSyncedAt: new Date().toISOString(),
    });
    await this.cache.upsertRunSummary({
      row: {
        run: detail.run,
        agentName: detail.agentName,
        orgName: detail.orgName,
        issue: detail.issue,
        bundle: detail.bundle,
      },
      findingSummary: diagnosis.summary,
      lastSyncedAt: new Date().toISOString(),
    });
    return { detail, diagnosis, trace };
  }

  private async ingestRows(rows: RunExportRow[]) {
    for (const row of rows) {
      await this.cache.upsertRunSummary({
        row,
        findingSummary: summarizeRun(row),
        lastSyncedAt: new Date().toISOString(),
      });
      if (row.run.status === "running" || row.run.status === "failed" || row.run.status === "timed_out") {
        await this.refreshRunDetail(row.run.id).catch(() => undefined);
      }
    }
  }

  private ensureSocket(orgId: string) {
    if (this.sockets.has(orgId)) return;
    const wsUrl = this.rudderApiUrl.replace(/^http/, "ws").replace(/\/api$/, "") + `/api/orgs/${encodeURIComponent(orgId)}/events/ws`;
    const socket = new WebSocket(wsUrl);
    this.sockets.set(orgId, socket);

    socket.on("message", (message) => {
      try {
        const event = JSON.parse(String(message)) as LiveEvent;
        const runId = typeof event.payload?.runId === "string" ? event.payload.runId : null;
        if (!runId) return;
        if (event.type === "heartbeat.run.status" || event.type === "heartbeat.run.event" || event.type === "heartbeat.run.log" || event.type === "heartbeat.run.queued") {
          void this.synchronizeOrganization(orgId);
          void this.refreshRunDetail(runId).catch(() => undefined);
        }
      } catch {
        return;
      }
    });

    socket.on("close", () => {
      this.sockets.delete(orgId);
      setTimeout(() => this.ensureSocket(orgId), 1500);
    });

    socket.on("error", () => {
      socket.close();
    });
  }
}

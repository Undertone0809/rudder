import fs from "node:fs/promises";
import path from "node:path";
import { buildObservedRunTrace, type ObservedRunDetail, type ObservedRunTrace, type RunDiagnosis, type RunExportRow } from "@rudder/run-intelligence-core";

export interface CachedRunSummary {
  row: RunExportRow;
  findingSummary: string;
  lastSyncedAt: string;
}

export interface CachedRunDetail {
  detail: ObservedRunDetail;
  diagnosis: RunDiagnosis;
  trace: ObservedRunTrace;
  lastSyncedAt: string;
}

interface CacheState {
  organizations: Array<{ id: string; name: string }>;
  runs: Record<string, CachedRunSummary>;
  cursors: Record<string, string>;
}

export class RunIntelligenceCache {
  private state: CacheState = {
    organizations: [],
    runs: {},
    cursors: {},
  };

  constructor(private readonly cacheDir: string) {}

  private get stateFile() {
    return path.join(this.cacheDir, "state.json");
  }

  private detailFile(runId: string) {
    return path.join(this.cacheDir, "runs", `${runId}.json`);
  }

  async init() {
    await fs.mkdir(path.join(this.cacheDir, "runs"), { recursive: true });
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      this.state = JSON.parse(raw) as CacheState;
    } catch {
      await this.flushState();
    }
  }

  private async flushState() {
    await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  getOrganizations() {
    return [...this.state.organizations];
  }

  async setOrganizations(organizations: Array<{ id: string; name: string }>) {
    this.state.organizations = organizations;
    await this.flushState();
  }

  listRuns() {
    return Object.values(this.state.runs);
  }

  getRun(runId: string) {
    return this.state.runs[runId] ?? null;
  }

  async upsertRunSummary(summary: CachedRunSummary) {
    this.state.runs[summary.row.run.id] = summary;
    const existingCursor = this.state.cursors[summary.row.run.orgId];
    const nextCursor = new Date(summary.row.run.updatedAt).toISOString();
    if (!existingCursor || new Date(nextCursor).getTime() > new Date(existingCursor).getTime()) {
      this.state.cursors[summary.row.run.orgId] = nextCursor;
    }
    await this.flushState();
  }

  getCursor(orgId: string) {
    return this.state.cursors[orgId] ?? null;
  }

  async setCursor(orgId: string, updatedAtIso: string) {
    this.state.cursors[orgId] = updatedAtIso;
    await this.flushState();
  }

  async writeRunDetail(detail: CachedRunDetail) {
    const normalized = {
      ...detail,
      trace: detail.trace ?? buildObservedRunTrace(detail.detail),
    } satisfies CachedRunDetail;
    await fs.writeFile(this.detailFile(detail.detail.run.id), JSON.stringify(normalized, null, 2));
  }

  async readRunDetail(runId: string): Promise<CachedRunDetail | null> {
    try {
      const raw = await fs.readFile(this.detailFile(runId), "utf8");
      const parsed = JSON.parse(raw) as Partial<CachedRunDetail> & Pick<CachedRunDetail, "detail" | "diagnosis" | "lastSyncedAt">;
      return {
        ...parsed,
        trace: parsed.trace ?? buildObservedRunTrace(parsed.detail),
      } satisfies CachedRunDetail;
    } catch {
      return null;
    }
  }
}

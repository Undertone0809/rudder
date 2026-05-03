import { randomUUID } from "node:crypto";
import type {
  OrganizationExportJob,
  OrganizationExportJobProgress,
  OrganizationExportJobStage,
  OrganizationPortabilityExportResult,
} from "@rudderhq/shared";

const EXPORT_JOB_TTL_MS = 15 * 60 * 1000;

export type ExportJobProgressUpdate = Partial<OrganizationExportJobProgress> & {
  stage: OrganizationExportJobStage;
  message: string;
};

export type ExportJobBuild = (options: {
  signal: AbortSignal;
  onProgress: (progress: ExportJobProgressUpdate) => void;
}) => Promise<OrganizationPortabilityExportResult>;

type ExportJobRecord = OrganizationExportJob & {
  controller: AbortController;
  result: OrganizationPortabilityExportResult | null;
  cleanupTimer: NodeJS.Timeout;
};

function nowIso() {
  return new Date().toISOString();
}

function expiresAtIso(nowMs = Date.now()) {
  return new Date(nowMs + EXPORT_JOB_TTL_MS).toISOString();
}

function serializeJob(job: ExportJobRecord): OrganizationExportJob {
  return {
    id: job.id,
    orgId: job.orgId,
    status: job.status,
    progress: job.progress,
    error: job.error,
    resultAvailable: job.result !== null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
  };
}

export function organizationExportJobService() {
  const jobs = new Map<string, ExportJobRecord>();

  function scheduleCleanup(job: ExportJobRecord) {
    clearTimeout(job.cleanupTimer);
    job.expiresAt = expiresAtIso();
    job.cleanupTimer = setTimeout(() => {
      jobs.delete(job.id);
    }, EXPORT_JOB_TTL_MS);
    job.cleanupTimer.unref?.();
  }

  function updateProgress(job: ExportJobRecord, progress: ExportJobProgressUpdate) {
    job.progress = {
      stage: progress.stage,
      message: progress.message,
      completed: progress.completed ?? job.progress.completed,
      total: progress.total ?? job.progress.total,
      fileCount: progress.fileCount ?? job.progress.fileCount,
    };
    job.updatedAt = nowIso();
  }

  function create(orgId: string, build: ExportJobBuild): OrganizationExportJob {
    const controller = new AbortController();
    const createdAt = nowIso();
    const job: ExportJobRecord = {
      id: randomUUID(),
      orgId,
      status: "queued",
      progress: {
        stage: "queued",
        message: "Preparing export build.",
        completed: 0,
        total: 8,
        fileCount: null,
      },
      error: null,
      resultAvailable: false,
      createdAt,
      updatedAt: createdAt,
      expiresAt: expiresAtIso(),
      controller,
      result: null,
      cleanupTimer: setTimeout(() => undefined, 0),
    };
    jobs.set(job.id, job);
    scheduleCleanup(job);

    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      job.status = "running";
      job.updatedAt = nowIso();
      try {
        const result = await build({
          signal: controller.signal,
          onProgress: (progress) => updateProgress(job, progress),
        });
        if (controller.signal.aborted) return;
        job.result = result;
        job.status = "succeeded";
        updateProgress(job, {
          stage: "ready",
          message: "Export package is ready to download.",
          completed: 8,
          total: 8,
          fileCount: Object.keys(result.files).length,
        });
        scheduleCleanup(job);
      } catch (err) {
        if (controller.signal.aborted) {
          job.status = "canceled";
          updateProgress(job, {
            stage: "canceled",
            message: "Export build was canceled.",
            completed: job.progress.completed,
            total: job.progress.total,
          });
          scheduleCleanup(job);
          return;
        }
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        updateProgress(job, {
          stage: "failed",
          message: "Export build failed.",
          completed: job.progress.completed,
          total: job.progress.total,
        });
        scheduleCleanup(job);
      }
    });

    return serializeJob(job);
  }

  function get(jobId: string): OrganizationExportJob | null {
    const job = jobs.get(jobId);
    return job ? serializeJob(job) : null;
  }

  function getResult(jobId: string): OrganizationPortabilityExportResult | null {
    return jobs.get(jobId)?.result ?? null;
  }

  function cancel(jobId: string): OrganizationExportJob | null {
    const job = jobs.get(jobId);
    if (!job) return null;
    if (job.status === "succeeded" || job.status === "failed" || job.status === "canceled") {
      return serializeJob(job);
    }
    job.controller.abort();
    job.status = "canceled";
    updateProgress(job, {
      stage: "canceled",
      message: "Export build was canceled.",
      completed: job.progress.completed,
      total: job.progress.total,
    });
    scheduleCleanup(job);
    return serializeJob(job);
  }

  return {
    create,
    get,
    getResult,
    cancel,
  };
}

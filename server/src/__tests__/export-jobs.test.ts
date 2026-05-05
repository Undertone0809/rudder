import { describe, expect, it } from "vitest";
import { organizationExportJobService } from "../services/export-jobs.js";
import type { OrganizationPortabilityExportResult } from "@rudderhq/shared";

const result: OrganizationPortabilityExportResult = {
  rootPath: "acme",
  manifest: {
    schemaVersion: 1,
    generatedAt: "2026-05-03T00:00:00.000Z",
    source: { orgId: "org-1", organizationName: "Acme" },
    includes: { organization: true, agents: false, projects: false, issues: false, skills: false },
    organization: null,
    sidebar: null,
    agents: [],
    skills: [],
    projects: [],
    issues: [],
    envInputs: [],
  },
  files: {
    "ORGANIZATION.md": "# Acme",
  },
  warnings: [],
  rudderExtensionPath: ".rudder.yaml",
};

async function eventually<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 1000;
  let value = read();
  while (!predicate(value)) {
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = read();
  }
  return value;
}

describe("organizationExportJobService", () => {
  it("tracks a successful export job and exposes the result", async () => {
    const jobs = organizationExportJobService();
    const created = jobs.create("org-1", async ({ onProgress }) => {
      onProgress({
        stage: "rendering_agents",
        message: "Rendering agents.",
        completed: 4,
        total: 8,
        fileCount: 1,
      });
      return result;
    });

    const completed = await eventually(
      () => jobs.get(created.id),
      (job) => job?.status === "succeeded",
    );

    expect(completed?.status).toBe("succeeded");
    expect(completed?.resultAvailable).toBe(true);
    expect(completed?.progress.stage).toBe("ready");
    expect(jobs.getResult(created.id)).toEqual(result);
  });

  it("cancels a pending export job", async () => {
    const jobs = organizationExportJobService();
    const created = jobs.create("org-1", async ({ signal }) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return result;
    });

    const canceled = jobs.cancel(created.id);

    expect(canceled?.status).toBe("canceled");
    expect(canceled?.progress.stage).toBe("canceled");
    expect(jobs.getResult(created.id)).toBeNull();
  });
});

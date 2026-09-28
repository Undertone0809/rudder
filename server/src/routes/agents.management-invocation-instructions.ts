import type { Db } from "@rudderhq/db";
import type { Request, Router } from "express";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactRecoveredInstructionText } from "../services/run-instruction-recovery-redaction.js";
import { readRecoveredRunDeveloperInstructions, readRunInstructionSnapshotForEvent } from "../services/run-instruction-snapshots.js";
import {
  assertRunIntelligenceAccess,
  resolveRunIdReferenceForScope,
  type RunIntelligenceAccessScope,
} from "../services/run-intelligence-access.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess } from "./authz.js";

type AccessibleRun = Parameters<typeof assertRunIntelligenceAccess>[1] & { id: string };

export function registerAgentInvocationInstructionsRoute(input: {
  router: Router;
  db: Db;
  storage?: StorageService;
  heartbeat: { getRun(runId: string): Promise<AccessibleRun | null> };
  getCurrentUserRedactionOptions: () => Promise<Parameters<typeof redactCurrentUserText>[1]>;
  resolveScope: (req: Request, notFoundMessage?: string) => RunIntelligenceAccessScope;
}) {
  input.router.get("/agent-runs/:runId/events/:eventId/invocation-instructions", async (req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    const scope = input.resolveScope(req, "Agent run not found");
    const runId = await resolveRunIdReferenceForScope(input.db, req.params.runId as string, scope);
    const run = await input.heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Agent run not found" });
      return;
    }
    assertCompanyAccess(req, run.orgId);
    await assertRunIntelligenceAccess(input.db, run, scope);

    const eventIdText = String(req.params.eventId ?? "");
    const eventId = Number(eventIdText);
    if (!/^[1-9][0-9]*$/u.test(eventIdText) || !Number.isSafeInteger(eventId)) {
      res.status(404).json({ error: "Invocation instruction snapshot not found" });
      return;
    }
    if (!input.storage) {
      res.status(503).json({ error: "Invocation instruction storage is unavailable" });
      return;
    }

    const snapshot = await readRunInstructionSnapshotForEvent({
      db: input.db,
      storage: input.storage,
      orgId: run.orgId,
      runId: run.id,
      eventId,
    });
    if (!snapshot) {
      const recovered = await readRecoveredRunDeveloperInstructions({
        db: input.db, orgId: run.orgId, runId: run.id, eventId,
      });
      if (recovered) {
        const redaction = await input.getCurrentUserRedactionOptions();
        res.json({ ...recovered, developerInstructions: redactCurrentUserText(redactRecoveredInstructionText(recovered.developerInstructions), redaction) });
        return;
      }
      res.status(404).json({ error: "Invocation instruction snapshot not found" });
      return;
    }

    const currentUserRedactionOptions = await input.getCurrentUserRedactionOptions();
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json({
      source: "stored_snapshot",
      completeness: "complete",
      agentInstructionStack: redactCurrentUserText(snapshot.agentInstructionStack, currentUserRedactionOptions),
      sha256: snapshot.sha256,
      byteSize: snapshot.byteSize,
    });
  });
}

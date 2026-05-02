import { Router } from "express";
import type { Db } from "@rudderhq/db";
import {
  createRunFeedbackItemSchema,
  createRunFeedbackSessionSchema,
  updateLearningCandidateSchema,
} from "@rudderhq/shared";
import { validate } from "../middleware/validate.js";
import { agentLearningService } from "../services/agent-learning.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function agentLearningRoutes(db: Db) {
  const router = Router();
  const svc = agentLearningService(db);

  function assertLearningMutation(req: Parameters<typeof assertBoard>[0], orgId: string) {
    assertCompanyAccess(req, orgId);
    assertBoard(req);
  }

  router.post(
    "/orgs/:orgId/run-feedback-sessions",
    validate(createRunFeedbackSessionSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertLearningMutation(req, orgId);
      const session = await svc.createSession(orgId, req.body, getActorInfo(req));
      res.status(201).json(session);
    },
  );

  router.post(
    "/orgs/:orgId/run-feedback-sessions/:sessionId/items",
    validate(createRunFeedbackItemSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const sessionId = req.params.sessionId as string;
      assertLearningMutation(req, orgId);
      const item = await svc.addFeedbackItem(orgId, sessionId, req.body);
      res.status(201).json(item);
    },
  );

  router.post("/orgs/:orgId/run-feedback-sessions/:sessionId/submit", async (req, res) => {
    const orgId = req.params.orgId as string;
    const sessionId = req.params.sessionId as string;
    assertLearningMutation(req, orgId);
    const result = await svc.submitSession(orgId, sessionId, getActorInfo(req));
    res.status(201).json(result);
  });

  router.get("/orgs/:orgId/runs/:runId/feedback", async (req, res) => {
    const orgId = req.params.orgId as string;
    const runId = req.params.runId as string;
    assertCompanyAccess(req, orgId);
    res.json(await svc.listRunFeedback(orgId, runId));
  });

  router.get("/orgs/:orgId/feedback-batches/:batchId/review", async (req, res) => {
    const orgId = req.params.orgId as string;
    const batchId = req.params.batchId as string;
    assertCompanyAccess(req, orgId);
    res.json(await svc.getBatchReview(orgId, batchId));
  });

  router.get("/orgs/:orgId/feedback-batches/:batchId/learnings", async (req, res) => {
    const orgId = req.params.orgId as string;
    const batchId = req.params.batchId as string;
    assertCompanyAccess(req, orgId);
    const review = await svc.getBatchReview(orgId, batchId);
    res.json(review.candidates);
  });

  router.patch(
    "/orgs/:orgId/learning-candidates/:learningId",
    validate(updateLearningCandidateSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const learningId = req.params.learningId as string;
      assertLearningMutation(req, orgId);
      res.json(await svc.updateCandidate(orgId, learningId, req.body));
    },
  );

  router.post("/orgs/:orgId/learning-candidates/:learningId/approve", async (req, res) => {
    const orgId = req.params.orgId as string;
    const learningId = req.params.learningId as string;
    assertLearningMutation(req, orgId);
    res.json(await svc.setCandidateStatus(orgId, learningId, "approved"));
  });

  router.post("/orgs/:orgId/learning-candidates/:learningId/reject", async (req, res) => {
    const orgId = req.params.orgId as string;
    const learningId = req.params.learningId as string;
    assertLearningMutation(req, orgId);
    res.json(await svc.setCandidateStatus(orgId, learningId, "rejected"));
  });

  router.post("/orgs/:orgId/learning-candidates/:learningId/one-off", async (req, res) => {
    const orgId = req.params.orgId as string;
    const learningId = req.params.learningId as string;
    assertLearningMutation(req, orgId);
    res.json(await svc.setCandidateStatus(orgId, learningId, "one_off"));
  });

  router.post("/orgs/:orgId/feedback-batches/:batchId/apply-approved", async (req, res) => {
    const orgId = req.params.orgId as string;
    const batchId = req.params.batchId as string;
    assertLearningMutation(req, orgId);
    res.json(await svc.applyApproved(orgId, batchId, getActorInfo(req)));
  });

  router.post("/orgs/:orgId/skill-update-proposals/:proposalId/apply", async (req, res) => {
    const orgId = req.params.orgId as string;
    const proposalId = req.params.proposalId as string;
    assertLearningMutation(req, orgId);
    res.json(await svc.applyProposal(orgId, proposalId, getActorInfo(req)));
  });

  router.post("/orgs/:orgId/skill-update-proposals/:proposalId/reject", async (req, res) => {
    const orgId = req.params.orgId as string;
    const proposalId = req.params.proposalId as string;
    assertLearningMutation(req, orgId);
    res.json(await svc.rejectProposal(orgId, proposalId));
  });

  router.get("/orgs/:orgId/agents/:agentId/learnings/summary", async (req, res) => {
    const orgId = req.params.orgId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, orgId);
    res.json(await svc.agentSummary(orgId, agentId));
  });

  router.get("/orgs/:orgId/runs/:runId/loaded-skills", async (req, res) => {
    const orgId = req.params.orgId as string;
    const runId = req.params.runId as string;
    assertCompanyAccess(req, orgId);
    res.json(await svc.getRunLoadedSkills(orgId, runId));
  });

  router.post("/orgs/:orgId/runs/:runId/evaluate-skills", async (req, res) => {
    const orgId = req.params.orgId as string;
    const runId = req.params.runId as string;
    assertLearningMutation(req, orgId);
    res.status(201).json(await svc.evaluateRunSkills(orgId, runId));
  });

  router.get("/orgs/:orgId/runs/:runId/skill-evaluations", async (req, res) => {
    const orgId = req.params.orgId as string;
    const runId = req.params.runId as string;
    assertCompanyAccess(req, orgId);
    const summary = await svc.getRunLoadedSkills(orgId, runId);
    res.json(summary.evaluations);
  });

  return router;
}

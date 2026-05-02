import type {
  AgentLearningSummary,
  ApplyApprovedLearningResponse,
  CreateRunFeedbackItemRequest,
  CreateRunFeedbackSessionRequest,
  FeedbackBatchReview,
  LearningCandidate,
  RunFeedbackItem,
  RunFeedbackSession,
  RunLoadedSkillsSummary,
  SkillEvaluationReport,
  SubmitRunFeedbackSessionResponse,
  UpdateLearningCandidateRequest,
} from "@rudderhq/shared";
import { api } from "./client";

export const agentLearningApi = {
  createFeedbackSession: (orgId: string, payload: CreateRunFeedbackSessionRequest) =>
    api.post<RunFeedbackSession>(
      `/orgs/${encodeURIComponent(orgId)}/run-feedback-sessions`,
      payload,
    ),
  addFeedbackItem: (orgId: string, sessionId: string, payload: CreateRunFeedbackItemRequest) =>
    api.post<RunFeedbackItem>(
      `/orgs/${encodeURIComponent(orgId)}/run-feedback-sessions/${encodeURIComponent(sessionId)}/items`,
      payload,
    ),
  submitFeedbackSession: (orgId: string, sessionId: string) =>
    api.post<SubmitRunFeedbackSessionResponse>(
      `/orgs/${encodeURIComponent(orgId)}/run-feedback-sessions/${encodeURIComponent(sessionId)}/submit`,
      {},
    ),
  batchReview: (orgId: string, batchId: string) =>
    api.get<FeedbackBatchReview>(
      `/orgs/${encodeURIComponent(orgId)}/feedback-batches/${encodeURIComponent(batchId)}/review`,
    ),
  updateCandidate: (orgId: string, learningId: string, payload: UpdateLearningCandidateRequest) =>
    api.patch<LearningCandidate>(
      `/orgs/${encodeURIComponent(orgId)}/learning-candidates/${encodeURIComponent(learningId)}`,
      payload,
    ),
  approveCandidate: (orgId: string, learningId: string) =>
    api.post<LearningCandidate>(
      `/orgs/${encodeURIComponent(orgId)}/learning-candidates/${encodeURIComponent(learningId)}/approve`,
      {},
    ),
  rejectCandidate: (orgId: string, learningId: string) =>
    api.post<LearningCandidate>(
      `/orgs/${encodeURIComponent(orgId)}/learning-candidates/${encodeURIComponent(learningId)}/reject`,
      {},
    ),
  oneOffCandidate: (orgId: string, learningId: string) =>
    api.post<LearningCandidate>(
      `/orgs/${encodeURIComponent(orgId)}/learning-candidates/${encodeURIComponent(learningId)}/one-off`,
      {},
    ),
  applyApproved: (orgId: string, batchId: string) =>
    api.post<ApplyApprovedLearningResponse>(
      `/orgs/${encodeURIComponent(orgId)}/feedback-batches/${encodeURIComponent(batchId)}/apply-approved`,
      {},
    ),
  agentSummary: (orgId: string, agentId: string) =>
    api.get<AgentLearningSummary>(
      `/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/learnings/summary`,
    ),
  runLoadedSkills: (orgId: string, runId: string) =>
    api.get<RunLoadedSkillsSummary>(
      `/orgs/${encodeURIComponent(orgId)}/runs/${encodeURIComponent(runId)}/loaded-skills`,
    ),
  evaluateRunSkills: (orgId: string, runId: string) =>
    api.post<SkillEvaluationReport[]>(
      `/orgs/${encodeURIComponent(orgId)}/runs/${encodeURIComponent(runId)}/evaluate-skills`,
      {},
    ),
  runSkillEvaluations: (orgId: string, runId: string) =>
    api.get<SkillEvaluationReport[]>(
      `/orgs/${encodeURIComponent(orgId)}/runs/${encodeURIComponent(runId)}/skill-evaluations`,
    ),
};

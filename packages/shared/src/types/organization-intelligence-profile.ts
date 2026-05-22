import type {
  AgentRuntimeType,
  OrganizationIntelligenceProfilePurpose,
  OrganizationIntelligenceProfileStatus,
} from "../constants.js";

export interface OrganizationIntelligenceProfile {
  id: string;
  orgId: string;
  purpose: OrganizationIntelligenceProfilePurpose;
  agentRuntimeType: AgentRuntimeType;
  agentRuntimeConfig: Record<string, unknown>;
  status: OrganizationIntelligenceProfileStatus;
  lastError: string | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertOrganizationIntelligenceProfile {
  agentRuntimeType: AgentRuntimeType;
  agentRuntimeConfig: Record<string, unknown>;
  status?: OrganizationIntelligenceProfileStatus;
}

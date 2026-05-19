import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_RUN_CONCURRENCY_DEFAULT,
  type AgentRuntimeEnvironmentTestResult,
  type Organization,
} from "@rudderhq/shared";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { organizationsApi } from "../api/orgs";
import { ApiError } from "../api/client";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { onboardingApi } from "../api/onboarding";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn, formatTime } from "../lib/utils";
import {
  extractModelName,
  extractProviderIdWithFallback
} from "../lib/model-utils";
import { resolveRuntimeModels } from "../lib/runtime-models";
import { getUIAdapter } from "../agent-runtimes";
import { defaultCreateValues } from "./agent-config-defaults";
import {
  filterRuntimeEnvironmentDisplayChecks,
  normalizeRuntimeEnvironmentDisplayStatus,
} from "./AgentConfigForm";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_SEARCH
} from "@rudderhq/agent-runtime-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@rudderhq/agent-runtime-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@rudderhq/agent-runtime-gemini-local";
import { resolveRouteOnboardingOptions } from "../lib/onboarding-route";
import { markProductTourPending } from "./ProductTourOverlay";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import {
  Building2,
  Bot,
  Code,
  Gem,
  ListTodo,
  Rocket,
  ArrowLeft,
  ArrowRight,
  Terminal,
  Sparkles,
  MousePointer2,
  Check,
  FolderKanban,
  Loader2,
  ChevronDown,
  X
} from "lucide-react";

export type Step = 1 | 2 | 3 | 4;
export type AdapterType =
  | "claude_local"
  | "codex_local"
  | "gemini_local"
  | "opencode_local"
  | "pi_local"
  | "cursor"
  | "http"
  | "openclaw_gateway";

export const DEFAULT_TASK_DESCRIPTION = `You are the CEO. You set the direction for the organization.

- hire a founding engineer
- write a hiring plan`;

export const ONBOARDING_PROJECT_NAME = "Getting Started";
export const ONBOARDING_DRAFT_ORGANIZATION_STORAGE_KEY =
  "rudder.onboardingDraftOrganizationId";

export function upsertOrganization(
  current: Organization[] | undefined,
  organization: Organization,
): Organization[] {
  if (!current || current.length === 0) {
    return [organization];
  }
  const existingIndex = current.findIndex((entry) => entry.id === organization.id);
  if (existingIndex < 0) {
    return [...current, organization];
  }
  return current.map((entry) => (entry.id === organization.id ? organization : entry));
}


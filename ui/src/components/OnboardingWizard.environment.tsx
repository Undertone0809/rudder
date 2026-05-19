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
import { Step, AdapterType, DEFAULT_TASK_DESCRIPTION, ONBOARDING_PROJECT_NAME, ONBOARDING_DRAFT_ORGANIZATION_STORAGE_KEY, upsertOrganization } from "./OnboardingWizard.parts";


export function AdapterEnvironmentResult({
  result
}: {
  result: AgentRuntimeEnvironmentTestResult;
}) {
  const displayStatus = normalizeRuntimeEnvironmentDisplayStatus(result.status) ?? "pass";
  const visibleChecks = filterRuntimeEnvironmentDisplayChecks(result);
  const statusLabel =
    displayStatus === "pass" ? "Passed" : "Failed";
  const statusClass =
    displayStatus === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-2.5 py-2 text-[11px] ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="opacity-80">
          {formatTime(result.testedAt)}
        </span>
      </div>
      {visibleChecks.length > 0 ? (
        <div className="mt-1.5 space-y-1">
          {visibleChecks.map((check, idx) => (
            <div
              key={`${check.code}-${idx}`}
              className="leading-relaxed break-words"
            >
              <span className="font-medium uppercase tracking-wide opacity-80">
                {check.level}
              </span>
              <span className="mx-1 opacity-60">·</span>
              <span>{check.message}</span>
              {check.detail && (
                <span className="block opacity-75 break-all">
                  ({check.detail})
                </span>
              )}
              {check.hint && (
                <span className="block opacity-90 break-words">
                  Hint: {check.hint}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}


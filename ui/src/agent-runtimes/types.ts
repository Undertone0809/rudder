import type { ComponentType } from "react";
import type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";

// Re-export shared types so local consumers don't need to change imports
export type { TranscriptEntry, StdoutLineParser, CreateConfigValues } from "@rudderhq/agent-runtime-utils";

export interface AgentRuntimeConfigFieldsProps {
  mode: "create" | "edit";
  isCreate: boolean;
  agentRuntimeType: string;
  /** Create mode: raw form values */
  values: CreateConfigValues | null;
  /** Create mode: setter for form values */
  set: ((patch: Partial<CreateConfigValues>) => void) | null;
  /** Edit mode: original agentRuntimeConfig from agent */
  config: Record<string, unknown>;
  /** Edit mode: read effective value */
  eff: <T>(group: "agentRuntimeConfig", field: string, original: T) => T;
  /** Edit mode: mark field dirty */
  mark: (group: "agentRuntimeConfig", field: string, value: unknown) => void;
  /** Available models for dropdowns */
  models: { id: string; label: string }[];
  /** When true, hides the instructions file path field (e.g. during import where it's set automatically) */
  hideInstructionsFile?: boolean;
}

export interface UIAgentRuntimeModule {
  type: string;
  label: string;
  parseStdoutLine: (line: string, ts: string) => import("@rudderhq/agent-runtime-utils").TranscriptEntry[];
  ConfigFields: ComponentType<AgentRuntimeConfigFieldsProps>;
  buildAdapterConfig: (values: CreateConfigValues) => Record<string, unknown>;
}

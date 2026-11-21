import { buildCodexLocalConfig, parseCodexStdoutLine } from "@rudderhq/agent-runtime-codex-local/ui";
import { NEW_AGENT_CODEX_LOCAL_MODEL, NEW_AGENT_CODEX_LOCAL_REASONING_EFFORT } from "../../lib/runtime-models";
import type { UIAgentRuntimeModule } from "../types";
import { CodexLocalConfigFields } from "./config-fields";

export const codexLocalUIAdapter: UIAgentRuntimeModule = {
  type: "codex_local",
  label: "Codex (local)",
  parseStdoutLine: parseCodexStdoutLine,
  ConfigFields: CodexLocalConfigFields,
  buildAdapterConfig: (values) => {
    const model = values.model.trim() || NEW_AGENT_CODEX_LOCAL_MODEL;
    const thinkingEffort = values.thinkingEffort.trim()
      || (model === NEW_AGENT_CODEX_LOCAL_MODEL ? NEW_AGENT_CODEX_LOCAL_REASONING_EFFORT : "");
    return {
      ...buildCodexLocalConfig({ ...values, model, thinkingEffort }),
      profileId: values.codexProfileId ?? "operator-default",
    };
  },
};

import { buildCursorLocalConfig, parseCursorStdoutLine } from "@rudderhq/agent-runtime-cursor-local/ui";
import type { UIAgentRuntimeModule } from "../types";
import { CursorLocalConfigFields } from "./config-fields";

export const cursorLocalUIAdapter: UIAgentRuntimeModule = {
  type: "cursor",
  label: "Cursor CLI (local)",
  parseStdoutLine: parseCursorStdoutLine,
  ConfigFields: CursorLocalConfigFields,
  buildAdapterConfig: buildCursorLocalConfig,
};

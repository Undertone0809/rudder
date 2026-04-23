import type { UIAgentRuntimeModule } from "../types";
import { parseCursorStdoutLine } from "@rudder/agent-runtime-cursor-local/ui";
import { CursorLocalConfigFields } from "./config-fields";
import { buildCursorLocalConfig } from "@rudder/agent-runtime-cursor-local/ui";

export const cursorLocalUIAdapter: UIAgentRuntimeModule = {
  type: "cursor",
  label: "Cursor CLI (local)",
  parseStdoutLine: parseCursorStdoutLine,
  ConfigFields: CursorLocalConfigFields,
  buildAdapterConfig: buildCursorLocalConfig,
};

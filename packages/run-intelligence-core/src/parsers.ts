import type { StdoutLineParser } from "@rudder/agent-runtime-utils";
import { parseClaudeStdoutLine } from "@rudder/agent-runtime-claude-local/ui";
import { parseCodexStdoutLine } from "@rudder/agent-runtime-codex-local/ui";
import { parseCursorStdoutLine } from "@rudder/agent-runtime-cursor-local/ui";
import { parseGeminiStdoutLine } from "@rudder/agent-runtime-gemini-local/ui";
import { parseOpenClawGatewayStdoutLine } from "@rudder/agent-runtime-openclaw-gateway/ui";
import { parseOpenCodeStdoutLine } from "@rudder/agent-runtime-opencode-local/ui";
import { parsePiStdoutLine } from "@rudder/agent-runtime-pi-local/ui";

const genericParser: StdoutLineParser = (line, ts) => [{ kind: "stdout", ts, text: line }];

const parserByRuntimeType: Record<string, StdoutLineParser> = {
  claude_local: parseClaudeStdoutLine,
  codex_local: parseCodexStdoutLine,
  cursor: parseCursorStdoutLine,
  gemini_local: parseGeminiStdoutLine,
  openclaw_gateway: parseOpenClawGatewayStdoutLine,
  opencode_local: parseOpenCodeStdoutLine,
  pi_local: parsePiStdoutLine,
  process: genericParser,
  http: genericParser,
};

export function getTranscriptParser(agentRuntimeType: string): StdoutLineParser {
  return parserByRuntimeType[agentRuntimeType] ?? genericParser;
}

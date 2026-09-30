import { parseClaudeStdoutLine } from "@rudderhq/agent-runtime-claude-local/ui";
import { parseCodexStdoutLine } from "@rudderhq/agent-runtime-codex-local/ui";
import { parseCursorStdoutLine } from "@rudderhq/agent-runtime-cursor-local/ui";
import { parseHermesGatewayStdoutLine } from "@rudderhq/agent-runtime-hermes-gateway";
import { parseOpenClawGatewayStdoutLine } from "@rudderhq/agent-runtime-openclaw-gateway/ui";
import { parseOpenCodeStdoutLine } from "@rudderhq/agent-runtime-opencode-local/ui";
import { parsePiStdoutLine } from "@rudderhq/agent-runtime-pi-local/ui";
import { parseRemovedGeminiLocalHistoryLine } from "@rudderhq/agent-runtime-utils/gemini-cli-history";
import type { StdoutLineParser } from "@rudderhq/agent-runtime-utils";

const genericParser: StdoutLineParser = (line, ts) => [{ kind: "stdout", ts, text: line }];

const parserByRuntimeType: Record<string, StdoutLineParser> = {
  claude_local: parseClaudeStdoutLine,
  codex_local: parseCodexStdoutLine,
  cursor: parseCursorStdoutLine,
  hermes_gateway: parseHermesGatewayStdoutLine,
  openclaw_gateway: parseOpenClawGatewayStdoutLine,
  opencode_local: parseOpenCodeStdoutLine,
  pi_local: parsePiStdoutLine,
  process: genericParser,
  http: genericParser,
};

export function getTranscriptParser(agentRuntimeType: string): StdoutLineParser {
  return parserByRuntimeType[agentRuntimeType] ?? genericParser;
}

const historyParserByRuntimeType: Record<string, StdoutLineParser> = {
  gemini_local: parseRemovedGeminiLocalHistoryLine,
};

export function getHistoricalTranscriptParser(agentRuntimeType: string): StdoutLineParser {
  return historyParserByRuntimeType[agentRuntimeType] ?? getTranscriptParser(agentRuntimeType);
}

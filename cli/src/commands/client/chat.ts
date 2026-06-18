import {
  addChatMessageSchema,
  createChatConversationSchema,
  updateChatConversationSchema,
  type ChatConversation,
  type ChatMessage,
  type ChatStreamTranscriptEntry,
} from "@rudderhq/shared";
import { Command } from "commander";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";
import {
  addCommonClientOptions,
  formatCliRunId,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import { formatExamplesAndCautions } from "./help.js";

interface ChatListOptions extends BaseClientOptions {
  status?: string;
  query?: string;
  limit?: string;
}

interface ChatSearchOptions extends BaseClientOptions {
  status?: string;
  scope?: string;
  limit?: string;
  snippetChars?: string;
}

interface ChatCreateOptions extends BaseClientOptions {
  payload?: string;
  title?: string;
  summary?: string;
  preferredAgentId?: string;
  issueCreationMode?: string;
  planMode?: boolean;
}

interface ChatMessagesOptions extends BaseClientOptions {
  includeTranscript?: boolean;
  includeOutput?: boolean;
  includeOutputs?: boolean;
  limit?: string;
  cursor?: string;
  maxOutputChars?: string;
}

interface ChatTranscriptOptions extends BaseClientOptions {
  limit?: string;
  cursor?: string;
  maxChars?: string;
  maxOutputChars?: string;
}

interface ChatReadOptions extends BaseClientOptions {
  includeTranscript?: boolean;
  includeOutput?: boolean;
  includeOutputs?: boolean;
  limit?: string;
  turnLimit?: string;
  cursor?: string;
  maxOutputChars?: string;
}

interface ChatSendOptions extends BaseClientOptions {
  body?: string;
  editUserMessageId?: string;
}

interface ChatMessagesPage {
  messages: ChatMessage[];
  page: {
    cursor: string | null;
    nextCursor: string | null;
    hasMore: boolean;
    limit: number;
    order: "newest" | "oldest";
    returnedMessages: number;
    totalMessages: number;
  };
}

export function registerChatCommands(program: Command): void {
  const chat = program.command("chat").description("Chat operations");

  addCommonClientOptions(
    chat
      .command("list")
      .description(getAgentCliCapabilityById("chat.list").description)
      .option("-O, --org-id <id>", "Organization ID")
      .option("--status <status>", "active, resolved, archived, or all", "active")
      .option("--query <text>", "Server-side chat search query")
      .option("--limit <n>", "Maximum rows to print")
      .action(async (opts: ChatListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await listChats(ctx, opts);
          printOutput(ctx.json ? rows : rows.map(formatChatConversation), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    chat
      .command("search")
      .description(getAgentCliCapabilityById("chat.search").description)
      .argument("<query>", "Search query")
      .option("-O, --org-id <id>", "Organization ID")
      .option("--status <status>", "active, resolved, archived, or all", "all")
      .option("--scope <scope>", "Search scope: all, title, summary, messages", "all")
      .option("--limit <n>", "Maximum rows to print", "20")
      .option("--snippet-chars <n>", "Maximum snippet characters", "220")
      .action(async (query: string, opts: ChatSearchOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await listChats(ctx, { ...opts, query });
          const filtered = filterChatSearchRows(rows, query, opts.scope ?? "all")
            .slice(0, parseLimit(opts.limit, rows.length));
          const snippetChars = parseLimit(opts.snippetChars, 220);
          printOutput(
            ctx.json ? filtered : filtered.map((row) => formatChatSearchResult(row, snippetChars)),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    chat
      .command("get")
      .description(getAgentCliCapabilityById("chat.get").description)
      .argument("<chatId>", "Chat conversation ID")
      .action(async (chatId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<ChatConversation>(`/api/chats/${encodeURIComponent(chatId)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    chat
      .command("messages")
      .description(getAgentCliCapabilityById("chat.messages").description)
      .argument("<chatId>", "Chat conversation ID")
      .option("--include-transcript", "Include assistant transcript entries")
      .option("--include-output", "Alias for --include-transcript")
      .option("--include-outputs", "Alias for --include-transcript")
      .option("--limit <n>", "Maximum messages to print")
      .option("--cursor <cursor>", "Stable message cursor returned in page.nextCursor")
      .option("--max-output-chars <n>", "Maximum transcript output chars for human output", "1200")
      .action(async (chatId: string, opts: ChatMessagesOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const page = await getChatMessagesPage(ctx, chatId, {
            includeTranscript: includesChatTranscript(opts),
            limit: opts.limit,
            cursor: opts.cursor,
          });
          printOutput(
            ctx.json ? page : page.messages.map((message) => formatChatMessage(message, parseLimit(opts.maxOutputChars, 1200))),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    chat
      .command("transcript")
      .description(getAgentCliCapabilityById("chat.transcript").description)
      .argument("<chatId>", "Chat conversation ID")
      .option("--limit <n>", "Maximum messages to print")
      .option("--cursor <cursor>", "Stable message cursor returned in page.nextCursor")
      .option("--max-chars <n>", "Maximum transcript chars per message", "1200")
      .option("--max-output-chars <n>", "Alias for --max-chars")
      .action(async (chatId: string, opts: ChatTranscriptOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const page = await getChatMessagesPage(ctx, chatId, {
            includeTranscript: true,
            limit: opts.limit,
            cursor: opts.cursor,
          });
          const maxChars = parseLimit(opts.maxOutputChars ?? opts.maxChars, 1200);
          printOutput(
            ctx.json ? page : page.messages.flatMap((message) => formatChatTranscriptMessage(message, maxChars)),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    chat
      .command("read")
      .description(getAgentCliCapabilityById("chat.read").description)
      .argument("<chatId>", "Chat conversation ID")
      .option("--include-transcript", "Include assistant transcript entries")
      .option("--include-output", "Alias for --include-transcript")
      .option("--include-outputs", "Alias for --include-transcript")
      .option("--limit <n>", "Maximum recent messages", "20")
      .option("--turn-limit <n>", "Alias for --limit for chat turn snapshots")
      .option("--cursor <cursor>", "Stable message cursor returned in page.nextCursor")
      .option("--max-output-chars <n>", "Maximum transcript output chars for human output", "1200")
      .addHelpText("after", formatExamplesAndCautions({
        examples: [
          {
            description: "Read a bounded conversation page with transcript output when needed:",
            command: "rudder chat read <chat-id> --turn-limit 20 --include-output",
          },
          {
            description: "Continue from a stable cursor in scripts:",
            command: "rudder chat read <chat-id> --cursor <nextCursor> --json",
          },
        ],
        cautions: [
          "Read bounded pages first; long chats can include large transcript payloads.",
          "Use --include-output only when transcript output is needed for diagnosis.",
        ],
      }))
      .action(async (chatId: string, opts: ChatReadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const [conversation, page] = await Promise.all([
            ctx.api.get<ChatConversation>(`/api/chats/${encodeURIComponent(chatId)}`),
            getChatMessagesPage(ctx, chatId, {
              includeTranscript: includesChatTranscript(opts),
              limit: opts.turnLimit ?? opts.limit,
              cursor: opts.cursor,
            }),
          ]);
          const payload = {
            conversation,
            messages: page.messages,
            page: page.page,
          };
          printOutput(
            ctx.json ? payload : page.messages.map((message) => formatChatMessage(message, parseLimit(opts.maxOutputChars, 1200))),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    chat
      .command("create")
      .description(getAgentCliCapabilityById("chat.create").description)
      .option("-O, --org-id <id>", "Organization ID")
      .option("--payload <json>", "Raw chat create payload JSON")
      .option("--title <title>", "Chat title")
      .option("--summary <text>", "Chat summary")
      .option("--preferred-agent-id <id>", "Preferred agent ID")
      .option("--issue-creation-mode <mode>", "Issue creation mode")
      .option("--plan-mode", "Create a plan-mode chat")
      .action(async (opts: ChatCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createChatConversationSchema.parse({
            ...parseJsonObjectOption(opts.payload, "--payload"),
            ...definedRecord({
              title: opts.title,
              summary: opts.summary,
              preferredAgentId: opts.preferredAgentId,
              issueCreationMode: opts.issueCreationMode,
              planMode: opts.planMode,
            }),
          });
          const created = await ctx.api.post<ChatConversation>(`/api/orgs/${ctx.orgId}/chats`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    chat
      .command("send")
      .description(getAgentCliCapabilityById("chat.send").description)
      .argument("<chatId>", "Chat conversation ID")
      .option("--body <text>", "Message body")
      .option("--edit-user-message-id <id>", "Regenerate/edit from a prior user message")
      .addHelpText("after", formatExamplesAndCautions({
        examples: [
          {
            description: "Append a short agent-authored status note:",
            command: "rudder chat send <chat-id> --body \"Status: validation is running\"",
          },
          {
            description: "Send a longer or multiline note through stdin:",
            command: "printf '%s\\n' 'Multiline note' | rudder chat send <chat-id>",
          },
        ],
        cautions: [
          "chat send accepts --body or stdin; it does not support --body-file.",
          "Agent-authenticated sends append an agent-authored message and do not start a new assistant reply.",
        ],
      }))
      .action(async (chatId: string, opts: ChatSendOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const body = opts.body ?? await readStdin();
          const payload = addChatMessageSchema.parse({
            body,
            editUserMessageId: opts.editUserMessageId,
          });
          const result = await ctx.api.post(`/api/chats/${encodeURIComponent(chatId)}/messages`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    chat
      .command("archive")
      .description(getAgentCliCapabilityById("chat.archive").description)
      .argument("<chatId>", "Chat conversation ID")
      .action(async (chatId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateChatConversationSchema.parse({ status: "archived" });
          const updated = await ctx.api.patch<ChatConversation>(`/api/chats/${encodeURIComponent(chatId)}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

async function listChats(ctx: ReturnType<typeof resolveCommandContext>, opts: ChatListOptions | { status?: string; query?: string; limit?: string }) {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.query) params.set("q", opts.query);
  const rows = (await ctx.api.get<ChatConversation[]>(`/api/orgs/${ctx.orgId}/chats?${params.toString()}`)) ?? [];
  return rows.slice(0, parseLimit(opts.limit, rows.length));
}

async function getChatMessagesPage(
  ctx: ReturnType<typeof resolveCommandContext>,
  chatId: string,
  opts: { includeTranscript: boolean; limit?: string; cursor?: string },
) {
  const params = new URLSearchParams();
  params.set("envelope", "true");
  params.set("order", "newest");
  params.set("limit", String(parseLimit(opts.limit, 50)));
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.includeTranscript) params.set("includeTranscript", "true");
  const page = await ctx.api.get<ChatMessagesPage>(`/api/chats/${encodeURIComponent(chatId)}/messages?${params.toString()}`);
  if (!page) {
    throw new Error("Chat messages response was empty");
  }
  return page;
}

function filterChatSearchRows(rows: ChatConversation[], query: string, scope: string) {
  const normalized = query.toLowerCase();
  if (scope === "all") return rows;
  return rows.filter((row) => {
    if (scope === "title") return row.title.toLowerCase().includes(normalized);
    if (scope === "summary") return Boolean(row.summary?.toLowerCase().includes(normalized));
    if (scope === "messages") return Boolean(row.searchPreview?.toLowerCase().includes(normalized));
    return true;
  });
}

function formatChatConversation(row: ChatConversation) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    preferredAgentId: row.preferredAgentId ?? "-",
    unread: row.unreadCount,
    lastMessageAt: row.lastMessageAt ?? "-",
    preview: row.latestReplyPreview ?? row.latestUserMessagePreview ?? "-",
  };
}

function formatChatSearchResult(row: ChatConversation, maxChars: number) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    lastMessageAt: row.lastMessageAt ?? "-",
    snippet: clip(row.searchPreview ?? row.latestReplyPreview ?? row.latestUserMessagePreview ?? row.summary ?? "", maxChars),
  };
}

function formatChatMessage(row: ChatMessage, maxOutputChars = 1200) {
  const runId = row.runId ? formatCliRunId(row.runId) : null;
  return {
    id: row.id,
    role: row.role,
    kind: row.kind,
    status: row.status,
    ...(runId ? {
      runId,
      runCommand: `rudder runs get ${runId}`,
      transcriptCommand: `rudder runs transcript ${runId}`,
    } : {}),
    createdAt: row.createdAt,
    body: clip(row.body, 220),
    transcriptEntries: row.transcriptSummary?.entryCount ?? row.transcript?.length ?? 0,
    ...(row.transcript?.length
      ? { transcriptPreview: clip(row.transcript.map((entry) => formatTranscriptEntry(entry, maxOutputChars)).join(" "), maxOutputChars) }
      : {}),
  };
}

function formatChatTranscriptMessage(row: ChatMessage, maxChars: number) {
  const runId = row.runId ? formatCliRunId(row.runId) : null;
  const header = {
    id: row.id,
    role: row.role,
    kind: row.kind,
    status: row.status,
    ...(runId ? {
      runId,
      runCommand: `rudder runs get ${runId}`,
      transcriptCommand: `rudder runs transcript ${runId}`,
    } : {}),
    createdAt: row.createdAt,
    body: clip(row.body, 220),
  };
  const transcriptRows = (row.transcript ?? []).map((entry, index) => ({
    id: `${row.id}:entry-${index + 1}`,
    messageId: row.id,
    role: row.role,
    entry: formatTranscriptEntry(entry, maxChars),
  }));
  return transcriptRows.length > 0 ? [header, ...transcriptRows] : [header];
}

function formatTranscriptEntry(entry: ChatStreamTranscriptEntry, maxChars: number) {
  if (entry.kind === "tool_call") return `${entry.ts} tool_call ${entry.name} ${clip(JSON.stringify(entry.input), maxChars)}`;
  if (entry.kind === "tool_result") return `${entry.ts} tool_result ${entry.toolName ?? entry.toolUseId} ${entry.isError ? "ERROR " : ""}${clip(entry.content, maxChars)}`;
  if (entry.kind === "result") return `${entry.ts} result ${entry.isError ? "ERROR " : ""}${clip(entry.text || entry.errors.join("; "), maxChars)}`;
  if ("text" in entry) return `${entry.ts} ${entry.kind} ${clip(entry.text, maxChars)}`;
  return `${entry.ts} ${entry.kind}`;
}

function parseLimit(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function includesChatTranscript(opts: { includeTranscript?: boolean; includeOutput?: boolean; includeOutputs?: boolean }) {
  return Boolean(opts.includeTranscript || opts.includeOutput || opts.includeOutputs);
}

function clip(value: string, maxChars: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function parseJsonObjectOption(value: string | undefined, label: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes("JSON object")) throw error;
    throw new Error(`${label} must be valid JSON`);
  }
}

function definedRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

import postgres from "../packages/db/node_modules/postgres/src/index.js";
import { resolveMigrationConnection } from "../packages/db/src/migration-runtime.js";

const LEGACY_KEY = "__chatTranscript";
const DEFAULT_BATCH_SIZE = 100;

function debug(message: string) {
  if (process.env.RUDDER_BACKFILL_DEBUG === "1") console.error(`[backfill] ${message}`);
}

type LegacyMessage = {
  id: string;
  org_id: string;
  conversation_id: string;
  role: string;
  kind: string;
  body: string;
  created_at: string;
  chat_turn_id: string | null;
  turn_variant: number;
  superseded_at: Date | null;
  structured_payload: Record<string, unknown> | null;
};

type ForkConversation = {
  id: string;
  org_id: string;
  forked_from_conversation_id: string | null;
  forked_from_message_id: string | null;
};

type ForkMessage = Pick<LegacyMessage, "id" | "role" | "kind" | "body" | "created_at" | "chat_turn_id" | "turn_variant" | "superseded_at">
  & Pick<LegacyMessage, "org_id" | "conversation_id" | "structured_payload">;

type Report = {
  legacyCandidates: number;
  legacyEligible: number;
  legacyMigrated: number;
  legacySkipped: Array<{ messageId: string; reason: string }>;
  forksChecked: number;
  forksEligible: number;
  forksRepaired: number;
  forkSkipped: Array<{ conversationId: string; reason: string }>;
};

function parseArgs(argv: string[]) {
  let dryRun = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--batch-size") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 10_000) {
        throw new Error("--batch-size must be an integer from 1 to 10000");
      }
      batchSize = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { dryRun, batchSize };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function asTranscript(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(isRecord) ? value : null;
}

function sameTimestamp(left: string, right: string): boolean {
  return left === right;
}

function beforeOrAt(left: ForkMessage, right: ForkMessage): boolean {
  const leftTime = BigInt(left.created_at);
  const rightTime = BigInt(right.created_at);
  return leftTime < rightTime || (leftTime === rightTime && left.id <= right.id);
}

function selectedSourceBranch(messages: ForkMessage[], boundary: ForkMessage): ForkMessage[] {
  const branch = messages.filter((message) => {
    if (!boundary.chat_turn_id) return message.superseded_at === null || message.id === boundary.id;
    if (message.chat_turn_id === boundary.chat_turn_id) {
      return message.turn_variant === boundary.turn_variant;
    }
    return message.superseded_at === null || message.chat_turn_id === null;
  });
  return branch.filter((message) => beforeOrAt(message, boundary));
}

async function tableExists(sql: postgres.Sql): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT to_regclass('public.chat_message_transcript_entries') IS NOT NULL AS exists
  `;
  return rows[0]?.exists === true;
}

async function lockLegacyBatch(
  tx: postgres.TransactionSql,
  cursor: { createdAt: string; id: string } | null,
  batchSize: number,
) {
  const candidates = cursor
    ? await tx<LegacyMessage[]>`
      SELECT id, org_id, conversation_id, role, kind, body,
             (extract(epoch FROM created_at) * 1000000)::bigint::text AS created_at,
             chat_turn_id, turn_variant, superseded_at, structured_payload
      FROM chat_messages
      WHERE structured_payload ? ${LEGACY_KEY}
        AND (
          (extract(epoch FROM created_at) * 1000000)::bigint > ${cursor.createdAt}::bigint
          OR (
            (extract(epoch FROM created_at) * 1000000)::bigint = ${cursor.createdAt}::bigint
            AND id > ${cursor.id}::uuid
          )
        )
      ORDER BY created_at, id
      LIMIT ${batchSize}
    `
    : await tx<LegacyMessage[]>`
      SELECT id, org_id, conversation_id, role, kind, body,
             (extract(epoch FROM created_at) * 1000000)::bigint::text AS created_at,
             chat_turn_id, turn_variant, superseded_at, structured_payload
      FROM chat_messages
      WHERE structured_payload ? ${LEGACY_KEY}
      ORDER BY created_at, id
      LIMIT ${batchSize}
    `;
  if (candidates.length === 0) return { rows: [], last: null };

  const candidateIds = candidates.map((message) => message.id);
  const unlockedRows = await tx<LegacyMessage[]>`
    SELECT id, org_id, conversation_id, role, kind, body,
           (extract(epoch FROM created_at) * 1000000)::bigint::text AS created_at,
           chat_turn_id, turn_variant, superseded_at, structured_payload
    FROM chat_messages
    WHERE id IN ${tx(candidateIds)}
      AND structured_payload ? ${LEGACY_KEY}
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
  `;
  const unlockedIds = new Set(unlockedRows.map((message) => message.id));
  const skippedIds = candidateIds.filter((id) => !unlockedIds.has(id));
  const waitedRows = skippedIds.length === 0
    ? []
    : await tx<LegacyMessage[]>`
      SELECT id, org_id, conversation_id, role, kind, body,
             (extract(epoch FROM created_at) * 1000000)::bigint::text AS created_at,
             chat_turn_id, turn_variant, superseded_at, structured_payload
      FROM chat_messages
      WHERE id IN ${tx(skippedIds)}
        AND structured_payload ? ${LEGACY_KEY}
      ORDER BY created_at, id
      FOR UPDATE
    `;
  const rows = [...unlockedRows, ...waitedRows].sort((left, right) =>
    left.created_at === right.created_at
      ? left.id.localeCompare(right.id)
      : left.created_at.localeCompare(right.created_at),
  );
  return { rows, last: candidates.at(-1) ?? null };
}

async function backfillLegacy(
  sql: postgres.Sql,
  options: { dryRun: boolean; batchSize: number },
  report: Report,
) {
  let cursor: { createdAt: string; id: string } | null = null;
  let batchNumber = 0;
  while (true) {
    batchNumber += 1;
    debug(`legacy batch ${batchNumber} query cursor=${cursor ? `${cursor.createdAt}/${cursor.id}` : "start"}`);
    const batch = await sql.begin(async (tx) => {
      const { rows, last } = await lockLegacyBatch(tx, cursor, options.batchSize);
      for (const message of rows) {
        report.legacyCandidates += 1;
        const transcript = asTranscript(message.structured_payload?.[LEGACY_KEY]);
        if (!transcript) {
          report.legacySkipped.push({ messageId: message.id, reason: "legacy transcript is not an array of objects" });
          continue;
        }
        const generationTranscriptRows = message.role === "assistant"
          ? await tx<{ count: number }[]>`
            SELECT count(*)::int AS count
            FROM chat_generation_events AS event
            JOIN chat_generations AS generation ON generation.id = event.generation_id
            JOIN (
              SELECT DISTINCT ON (candidate.assistant_message_id)
                     candidate.assistant_message_id,
                     candidate.generation_id
              FROM chat_generation_events AS candidate
              JOIN chat_generations AS candidate_generation ON candidate_generation.id = candidate.generation_id
              WHERE candidate.assistant_message_id = ${message.id}
                AND candidate.org_id = ${message.org_id}
                AND candidate_generation.org_id = ${message.org_id}
                AND candidate_generation.conversation_id = ${message.conversation_id}
              ORDER BY candidate.assistant_message_id,
                       candidate_generation.created_at DESC,
                       candidate.recorded_at DESC,
                       candidate.generation_seq DESC,
                       candidate.generation_id DESC
            ) AS selected_generation
              ON selected_generation.generation_id = event.generation_id
            WHERE event.assistant_message_id = ${message.id}
              AND event.org_id = ${message.org_id}
              AND event.event_kind = 'transcript'
              AND jsonb_typeof(event.payload->'entry') = 'object'
              AND (generation.accepted_through_seq IS NULL OR event.generation_seq <= generation.accepted_through_seq)
          `
          : [{ count: 0 }];
        const hasGenerationTranscript = Number(generationTranscriptRows[0]?.count ?? 0) > 0;
        if (hasGenerationTranscript) {
          report.legacyEligible += 1;
          if (!options.dryRun) {
            await tx`
              UPDATE chat_messages
              SET structured_payload = NULLIF(structured_payload - ${LEGACY_KEY}, '{}'::jsonb),
                  updated_at = now()
              WHERE id = ${message.id} AND structured_payload ? ${LEGACY_KEY}
            `;
            report.legacyMigrated += 1;
          }
          continue;
        }
        if (!options.dryRun && transcript.length > 0) {
          await tx`
            INSERT INTO chat_message_transcript_entries (org_id, message_id, entry_seq, payload)
            SELECT ${message.org_id}, ${message.id}, value.ordinality - 1, value.entry
            FROM jsonb_array_elements(${sql.json(transcript)}::jsonb) WITH ORDINALITY AS value(entry, ordinality)
            ON CONFLICT (message_id, entry_seq) DO NOTHING
          `;
        }
        const persisted = await tx<{ entry_seq: number; payload: Record<string, unknown> }[]>`
          SELECT entry_seq, payload
          FROM chat_message_transcript_entries
          WHERE org_id = ${message.org_id} AND message_id = ${message.id}
          ORDER BY entry_seq
        `;
        const valid = options.dryRun && persisted.length === 0
          ? true
          : persisted.length === transcript.length
          && persisted.every((entry, index) => entry.entry_seq === index && stableJson(entry.payload) === stableJson(transcript[index]));
        if (!valid) {
          report.legacySkipped.push({ messageId: message.id, reason: "entry count/order/payload validation failed" });
          continue;
        }
        report.legacyEligible += 1;
        if (!options.dryRun) {
          await tx`
            UPDATE chat_messages
            SET structured_payload = NULLIF(structured_payload - ${LEGACY_KEY}, '{}'::jsonb),
                updated_at = now()
            WHERE id = ${message.id} AND structured_payload ? ${LEGACY_KEY}
          `;
          report.legacyMigrated += 1;
        }
      }
      debug(`legacy batch ${batchNumber} processed rows=${rows.length} last=${last ? `${last.created_at}/${last.id}` : "none"}`);
      return {
        count: rows.length,
        last: last ? { createdAt: last.created_at, id: last.id } : null,
      };
    });
    debug(`legacy batch ${batchNumber} committed count=${batch.count}`);
    if (batch.count === 0 || !batch.last) break;
    if (cursor && (batch.last.createdAt < cursor.createdAt
      || (batch.last.createdAt === cursor.createdAt && batch.last.id <= cursor.id))) {
      throw new Error("legacy backfill cursor did not advance; refusing to loop");
    }
    cursor = batch.last;
  }
}

async function sourceTranscript(sql: postgres.Sql, message: ForkMessage): Promise<Record<string, unknown>[]> {
  if (message.role === "assistant") {
    const events = await sql<{ entry: Record<string, unknown> | null }[]>`
      SELECT event.payload->'entry' AS entry
      FROM chat_generation_events AS event
      JOIN chat_generations AS generation ON generation.id = event.generation_id
      JOIN (
        SELECT DISTINCT ON (candidate.assistant_message_id)
               candidate.assistant_message_id,
               candidate.generation_id
        FROM chat_generation_events AS candidate
        JOIN chat_generations AS candidate_generation ON candidate_generation.id = candidate.generation_id
        WHERE candidate.assistant_message_id = ${message.id}
          AND candidate.org_id = ${message.org_id}
          AND candidate_generation.org_id = ${message.org_id}
          AND candidate_generation.conversation_id = ${message.conversation_id}
        ORDER BY candidate.assistant_message_id,
                 candidate_generation.created_at DESC,
                 candidate.recorded_at DESC,
                 candidate.generation_seq DESC,
                 candidate.generation_id DESC
      ) AS selected_generation
        ON selected_generation.generation_id = event.generation_id
      WHERE event.assistant_message_id = ${message.id}
        AND event.org_id = ${message.org_id}
        AND event.event_kind = 'transcript'
        AND (generation.accepted_through_seq IS NULL OR event.generation_seq <= generation.accepted_through_seq)
      ORDER BY event.generation_seq
    `;
    if (events.length > 0) return events.flatMap((row) => row.entry && isRecord(row.entry) ? [row.entry] : []);
  }
  const entries = await sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload
    FROM chat_message_transcript_entries
    WHERE org_id = ${message.org_id} AND message_id = ${message.id}
    ORDER BY entry_seq
  `;
  if (entries.length > 0) return entries.map((row) => row.payload);
  return asTranscript(message.structured_payload?.[LEGACY_KEY]) ?? [];
}

async function repairOldForks(sql: postgres.Sql, options: { dryRun: boolean }, report: Report) {
  debug("fork repair query");
  const forks = await sql<ForkConversation[]>`
    SELECT id, org_id, forked_from_conversation_id, forked_from_message_id
    FROM chat_conversations
    WHERE forked_from_conversation_id IS NOT NULL
      AND forked_from_message_id IS NOT NULL
    ORDER BY created_at, id
  `;
  debug(`fork repair candidates=${forks.length}`);
  for (const fork of forks) {
    debug(`fork repair start=${fork.id}`);
    report.forksChecked += 1;
    const result = await sql.begin(async (tx) => {
      const sourceMessages = await tx<ForkMessage[]>`
        SELECT id, org_id, conversation_id, role, kind, body,
               (extract(epoch FROM created_at) * 1000000)::bigint::text AS created_at,
               chat_turn_id, turn_variant, superseded_at, structured_payload
        FROM chat_messages
        WHERE org_id = ${fork.org_id} AND conversation_id = ${fork.forked_from_conversation_id}
        ORDER BY created_at, id
        FOR UPDATE
      `;
      const boundary = sourceMessages.find((message) => message.id === fork.forked_from_message_id);
      if (!boundary) return { repaired: false, reason: "source boundary message is missing" };
      const sourceBranch = selectedSourceBranch(sourceMessages, boundary);
      const forkEvents = await tx<{ id: string; created_at: string }[]>`
        SELECT id, (extract(epoch FROM created_at) * 1000000)::bigint::text AS created_at
        FROM chat_messages
        WHERE org_id = ${fork.org_id}
          AND conversation_id = ${fork.id}
          AND kind = 'system_event'
          AND structured_payload->>'eventType' = 'chat_fork'
        ORDER BY created_at, id
        FOR UPDATE
      `;
      if (forkEvents.length !== 1) {
        return {
          repaired: false,
          reason: forkEvents.length === 0
            ? "fork system event is missing"
            : "multiple fork system events make the copy boundary ambiguous",
        };
      }
      const forkEvent = forkEvents[0]!;
      const targetMessages = await tx<ForkMessage[]>`
        SELECT id, org_id, conversation_id, role, kind, body,
               (extract(epoch FROM created_at) * 1000000)::bigint::text AS created_at,
               chat_turn_id, turn_variant, superseded_at, structured_payload
        FROM chat_messages
        WHERE org_id = ${fork.org_id}
          AND conversation_id = ${fork.id}
          AND kind <> 'system_event'
          AND (
          (
            (extract(epoch FROM created_at) * 1000000)::bigint < ${forkEvent.created_at}::bigint
            OR (
              (extract(epoch FROM created_at) * 1000000)::bigint = ${forkEvent.created_at}::bigint
              AND id < ${forkEvent.id}::uuid
            )
          )
        )
        ORDER BY created_at, id
        FOR UPDATE
      `;
      const usedSourceIds = new Set<string>();
      const matches: Array<{ source: ForkMessage; target: ForkMessage }> = [];
      for (const target of targetMessages) {
        const candidates = sourceBranch.filter((source) =>
          !usedSourceIds.has(source.id)
          && source.role === target.role
          && source.kind === target.kind
          && source.body === target.body
          && sameTimestamp(source.created_at, target.created_at),
        );
        if (candidates.length !== 1) {
          return { repaired: false, reason: candidates.length === 0 ? `no unambiguous source for target ${target.id}` : `ambiguous source for target ${target.id}` };
        }
        usedSourceIds.add(candidates[0].id);
        matches.push({ source: candidates[0], target });
      }
      const pendingRepairs: Array<{
        target: ForkMessage;
        transcript: Record<string, unknown>[];
        existing: Array<{ entry_seq: number; payload: Record<string, unknown> }>;
        legacyPresent: boolean;
      }> = [];
      for (const match of matches) {
        const transcript = await sourceTranscript(tx, match.source);
        if (transcript.length === 0) continue;
        const legacyPresent = match.target.structured_payload?.[LEGACY_KEY] !== undefined;
        const existing = await tx<{ entry_seq: number; payload: Record<string, unknown> }[]>`
          SELECT entry_seq, payload
          FROM chat_message_transcript_entries
          WHERE org_id = ${fork.org_id} AND message_id = ${match.target.id}
          ORDER BY entry_seq
        `;
        if (existing.length > 0) {
          const same = existing.length === transcript.length
            && existing.every((entry, index) => entry.entry_seq === index && stableJson(entry.payload) === stableJson(transcript[index]));
          if (!same) return { repaired: false, reason: `existing transcript conflicts for target ${match.target.id}` };
        }
        if (existing.length === 0 || legacyPresent) {
          pendingRepairs.push({ target: match.target, transcript, existing, legacyPresent });
        }
      }
      report.forksEligible += pendingRepairs.length;
      if (options.dryRun || pendingRepairs.length === 0) {
        return {
          repaired: pendingRepairs.length > 0,
          reason: pendingRepairs.length > 0 ? null : "no transcript snapshot required",
        };
      }

      // The entire fork is preflighted before the first write. Any unexpected
      // validation failure below must abort the transaction, otherwise a later
      // ambiguous target could leave the fork partially repaired.
      for (const pending of pendingRepairs) {
        if (pending.existing.length === 0) {
          await tx`
            INSERT INTO chat_message_transcript_entries (org_id, message_id, entry_seq, payload)
            SELECT ${fork.org_id}, ${pending.target.id}, value.ordinality - 1, value.entry
            FROM jsonb_array_elements(${sql.json(pending.transcript)}::jsonb) WITH ORDINALITY AS value(entry, ordinality)
          `;
        }
        const persisted = await tx<{ entry_seq: number; payload: Record<string, unknown> }[]>`
          SELECT entry_seq, payload
          FROM chat_message_transcript_entries
          WHERE org_id = ${fork.org_id} AND message_id = ${pending.target.id}
          ORDER BY entry_seq
        `;
        const valid = persisted.length === pending.transcript.length
          && persisted.every((entry, index) => entry.entry_seq === index && stableJson(entry.payload) === stableJson(pending.transcript[index]));
        if (!valid) throw new Error(`entry validation failed for target ${pending.target.id}`);
        if (pending.legacyPresent) {
          await tx`
            UPDATE chat_messages
            SET structured_payload = NULLIF(structured_payload - ${LEGACY_KEY}, '{}'::jsonb),
                updated_at = now()
            WHERE id = ${pending.target.id}
              AND org_id = ${fork.org_id}
              AND structured_payload ? ${LEGACY_KEY}
          `;
        }
      }
      return { repaired: true, reason: null };
    });
    debug(`fork repair done=${fork.id} repaired=${result.repaired} reason=${result.reason ?? "none"}`);
    if (result.repaired && !options.dryRun) report.forksRepaired += 1;
    if (!result.repaired && result.reason && result.reason !== "no transcript snapshot required") {
      report.forkSkipped.push({ conversationId: fork.id, reason: result.reason });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const connection = await resolveMigrationConnection();
  const sql = postgres(connection.connectionString, { max: 1, onnotice: () => {} });
  const report: Report = {
    legacyCandidates: 0,
    legacyEligible: 0,
    legacyMigrated: 0,
    legacySkipped: [],
    forksChecked: 0,
    forksEligible: 0,
    forksRepaired: 0,
    forkSkipped: [],
  };
  try {
    debug("resolve connection");
    if (!(await tableExists(sql))) {
      throw new Error("chat_message_transcript_entries does not exist; run the schema migration first");
    }
    debug("transcript entries table exists");
    await backfillLegacy(sql, options, report);
    debug("legacy backfill complete");
    await repairOldForks(sql, options, report);
    debug("fork repair complete");
    console.log(JSON.stringify({ source: connection.source, dryRun: options.dryRun, batchSize: options.batchSize, report }, null, 2));
    if (report.legacySkipped.length > 0 || report.forkSkipped.length > 0) process.exitCode = 2;
  } finally {
    await sql.end();
    await connection.stop();
  }
}

await main();

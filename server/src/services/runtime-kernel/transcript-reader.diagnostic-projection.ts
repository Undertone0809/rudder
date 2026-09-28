import { heartbeatRunEvents } from "@rudderhq/db";
import { sql } from "drizzle-orm";

export const DIAGNOSTIC_TEXT_CHARS = 8_192;
const DIAGNOSTIC_ID_CHARS = 256;

export function diagnosticLegacyEventProjection() {
  const entry = sql`coalesce(
    case when jsonb_typeof(${heartbeatRunEvents.payload}->'entry') = 'object' then ${heartbeatRunEvents.payload}->'entry' end,
    case when jsonb_typeof(${heartbeatRunEvents.payload}->'transcriptEntry') = 'object' then ${heartbeatRunEvents.payload}->'transcriptEntry' end,
    case when jsonb_typeof(${heartbeatRunEvents.payload}->'transcript') = 'object' then ${heartbeatRunEvents.payload}->'transcript' end,
    ${heartbeatRunEvents.payload}
  )`;
  const clip = (field: string, maximum = DIAGNOSTIC_TEXT_CHARS) => sql`case
    when jsonb_typeof(${entry}->${field}) = 'string'
      then to_jsonb(left(${entry}->>${field}, ${maximum}))
    else null
  end`;
  const originalLength = (field: string, maximum = DIAGNOSTIC_TEXT_CHARS) => sql`case
    when jsonb_typeof(${entry}->${field}) = 'string'
      and char_length(${entry}->>${field}) > ${maximum}
      then char_length(${entry}->>${field})
    else null
  end`;
  const numericOrBoolean = (field: string, expectedType: "number" | "boolean") => sql`case
    when jsonb_typeof(${entry}->${field}) = ${expectedType} then ${entry}->${field}
    else null
  end`;
  const errors = sql`case
    when jsonb_typeof(${entry}->'errors') = 'array' then (
      select coalesce(jsonb_agg(
        case when jsonb_typeof(error_entry.value) = 'string'
          then to_jsonb(left(error_entry.value #>> '{}', ${DIAGNOSTIC_TEXT_CHARS}))
          else to_jsonb(left(error_entry.value::text, ${DIAGNOSTIC_TEXT_CHARS}))
        end order by error_entry.ordinality
      ), '[]'::jsonb)
      from jsonb_array_elements(${entry}->'errors') with ordinality as error_entry(value, ordinality)
      where error_entry.ordinality <= 16
    )
    else '[]'::jsonb
  end`;
  const errorsTruncated = sql`case
    when jsonb_typeof(${entry}->'errors') = 'array' then (
      jsonb_array_length(${entry}->'errors') > 16
      or exists (
        select 1
        from jsonb_array_elements(${entry}->'errors') with ordinality as error_entry(value, ordinality)
        where error_entry.ordinality <= 16
          and case when jsonb_typeof(error_entry.value) = 'string'
            then char_length(error_entry.value #>> '{}') > ${DIAGNOSTIC_TEXT_CHARS}
            else char_length(error_entry.value::text) > ${DIAGNOSTIC_TEXT_CHARS}
          end
      )
    )
    else false
  end`;
  const originalErrorsTextLength = sql`case
    when jsonb_typeof(${entry}->'errors') = 'array' then (
      select case when count(*) = 0 then 0 else 8 + sum(
        char_length(case when jsonb_typeof(error_entry.value) = 'string'
          then error_entry.value #>> '{}'
          else error_entry.value::text
        end)
      ) + count(*) - 1 end
      from jsonb_array_elements(${entry}->'errors') as error_entry(value)
    )
    else 0
  end`;
  const projectedErrorsTextLength = sql`case
    when jsonb_typeof(${entry}->'errors') = 'array' then (
      select case when count(*) = 0 then 0 else 8 + sum(least(${DIAGNOSTIC_TEXT_CHARS},
        char_length(case when jsonb_typeof(error_entry.value) = 'string'
          then error_entry.value #>> '{}'
          else error_entry.value::text
        end)
      )) + count(*) - 1 end
      from jsonb_array_elements(${entry}->'errors') with ordinality as error_entry(value, ordinality)
      where error_entry.ordinality <= 16
    )
    else 0
  end`;
  const originalResultDetailTextLength = sql`case
    when ${entry}->>'kind' = 'result' then (
      case when jsonb_typeof(${entry}->'text') = 'string' then char_length(${entry}->>'text') else 0 end
      + case when jsonb_typeof(${entry}->'text') = 'string'
          and ${entry}->>'text' <> ''
          and case when jsonb_typeof(${entry}->'errors') = 'array'
            then jsonb_array_length(${entry}->'errors') > 0 else false end
        then 2 else 0 end
      + ${originalErrorsTextLength}
    )
    else null
  end`;
  const projectedResultDetailTextLength = sql`case
    when ${entry}->>'kind' = 'result' then (
      case when jsonb_typeof(${entry}->'text') = 'string' then least(${DIAGNOSTIC_TEXT_CHARS}, char_length(${entry}->>'text')) else 0 end
      + case when jsonb_typeof(${entry}->'text') = 'string'
          and left(${entry}->>'text', ${DIAGNOSTIC_TEXT_CHARS}) <> ''
          and case when jsonb_typeof(${entry}->'errors') = 'array'
            then jsonb_array_length(${entry}->'errors') > 0 else false end
        then 2 else 0 end
      + ${projectedErrorsTextLength}
    )
    else null
  end`;
  const itemsOmitted = sql`(${entry}->'items' is not null and ${entry}->'items' <> '[]'::jsonb)`;
  const projectedEntry = sql`jsonb_strip_nulls(jsonb_build_object(
    'kind', ${clip("kind", 128)},
    'ts', ${clip("ts", 128)},
    'text', ${clip("text")},
    'delta', ${clip("delta")},
    'content', ${clip("content")},
    'name', ${clip("name")},
    'toolName', ${clip("toolName")},
    'toolUseId', ${clip("toolUseId")},
    'phase', ${clip("phase")},
    'segmentId', ${clip("segmentId")},
    'source', ${clip("source")},
    'messageId', ${clip("messageId")},
    'controlActionId', ${clip("controlActionId")},
    'todoListId', ${clip("todoListId")},
    'model', ${clip("model")},
    'sessionId', ${clip("sessionId")},
    'subtype', ${clip("subtype")},
    'isError', ${numericOrBoolean("isError", "boolean")},
    'inputTokens', ${numericOrBoolean("inputTokens", "number")},
    'outputTokens', ${numericOrBoolean("outputTokens", "number")},
    'cachedTokens', ${numericOrBoolean("cachedTokens", "number")},
    'costUsd', ${numericOrBoolean("costUsd", "number")},
    'errors', ${errors},
    'items', '[]'::jsonb,
    '__rudderOriginalLengths', jsonb_strip_nulls(jsonb_build_object(
      'kind', ${originalLength("kind", 128)},
      'ts', ${originalLength("ts", 128)},
      'text', ${originalLength("text")},
      'delta', ${originalLength("delta")},
      'content', ${originalLength("content")},
      'name', ${originalLength("name")},
      'toolName', ${originalLength("toolName")},
      'toolUseId', ${originalLength("toolUseId")},
      'phase', ${originalLength("phase")},
      'segmentId', ${originalLength("segmentId")},
      'source', ${originalLength("source")},
      'messageId', ${originalLength("messageId")},
      'controlActionId', ${originalLength("controlActionId")},
      'todoListId', ${originalLength("todoListId")},
      'model', ${originalLength("model")},
      'sessionId', ${originalLength("sessionId")},
      'subtype', ${originalLength("subtype")},
      'detailText', case
        when ${originalResultDetailTextLength} > ${projectedResultDetailTextLength}
          then ${originalResultDetailTextLength}
        else null
      end
    )),
    '__rudderTruncatedFields',
      (case when ${errorsTruncated} then jsonb_build_array('errors') else '[]'::jsonb end)
      || (case when ${itemsOmitted} then jsonb_build_array('items') else '[]'::jsonb end)
      || (case when exists (
        select 1 from jsonb_object_keys(${entry}) as key_name
        where key_name not in (
          'kind', 'ts', 'text', 'delta', 'content', 'name', 'toolName', 'toolUseId', 'phase',
          'segmentId', 'source', 'messageId', 'controlActionId', 'todoListId', 'model', 'sessionId',
          'subtype', 'isError', 'inputTokens', 'outputTokens', 'cachedTokens', 'costUsd', 'errors',
          'items', 'spanId', 'span_id', 'attemptId', 'attempt_id', 'id', 'sourceEntryId',
          'source_entry_id', '__rudderOriginalLengths', '__rudderTruncatedFields'
        )
      ) then jsonb_build_array('unprojected') else '[]'::jsonb end)
  ))`;
  const spanIdText = sql`coalesce(
    case when jsonb_typeof(${heartbeatRunEvents.payload}->'spanId') = 'string' then ${heartbeatRunEvents.payload}->>'spanId' end,
    case when jsonb_typeof(${heartbeatRunEvents.payload}->'span_id') = 'string' then ${heartbeatRunEvents.payload}->>'span_id' end,
    case when jsonb_typeof(${entry}->'spanId') = 'string' then ${entry}->>'spanId' end,
    case when jsonb_typeof(${entry}->'span_id') = 'string' then ${entry}->>'span_id' end
  )`;
  const attemptIdText = sql`coalesce(
    case when jsonb_typeof(${heartbeatRunEvents.payload}->'attemptId') = 'string' then ${heartbeatRunEvents.payload}->>'attemptId' end,
    case when jsonb_typeof(${heartbeatRunEvents.payload}->'attempt_id') = 'string' then ${heartbeatRunEvents.payload}->>'attempt_id' end,
    case when jsonb_typeof(${entry}->'attemptId') = 'string' then ${entry}->>'attemptId' end,
    case when jsonb_typeof(${entry}->'attempt_id') = 'string' then ${entry}->>'attempt_id' end
  )`;
  const boundedId = (value: ReturnType<typeof sql>) => sql`case
    when ${value} is not null then to_jsonb(left(${value}, ${DIAGNOSTIC_ID_CHARS}))
    else null
  end`;
  const idOriginalLength = (value: ReturnType<typeof sql>) => sql`case
    when char_length(${value}) > ${DIAGNOSTIC_ID_CHARS} then char_length(${value})
    else null
  end`;
  const payload = sql`jsonb_strip_nulls(jsonb_build_object(
    'spanId', ${boundedId(spanIdText)},
    'attemptId', ${boundedId(attemptIdText)},
    'entry', ${projectedEntry},
    '__rudderOriginalLengths', jsonb_strip_nulls(jsonb_build_object(
      'message', case when char_length(coalesce(${heartbeatRunEvents.message}, '')) > ${DIAGNOSTIC_TEXT_CHARS}
        then char_length(${heartbeatRunEvents.message}) end,
      'spanId', ${idOriginalLength(spanIdText)},
      'attemptId', ${idOriginalLength(attemptIdText)}
    ))
  ))`;
  const byteLength = sql<number>`octet_length((${payload})::text) + 96`;
  const truncated = sql<boolean>`(
    coalesce(${projectedEntry}->'__rudderOriginalLengths', '{}'::jsonb) <> '{}'::jsonb
    or jsonb_array_length(coalesce(${projectedEntry}->'__rudderTruncatedFields', '[]'::jsonb)) > 0
    or char_length(coalesce(${heartbeatRunEvents.message}, '')) > ${DIAGNOSTIC_TEXT_CHARS}
    or char_length(coalesce(${heartbeatRunEvents.eventType}, '')) > 128
    or char_length(coalesce(${heartbeatRunEvents.stream}, '')) > 64
    or char_length(coalesce(${heartbeatRunEvents.level}, '')) > 32
    or char_length(coalesce(${heartbeatRunEvents.color}, '')) > 64
  )`;
  return { payload, byteLength, truncated };
}

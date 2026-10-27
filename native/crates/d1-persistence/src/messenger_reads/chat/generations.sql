SELECT jsonb_build_object('messageId',m.id,'generationId',g.id,'terminalReason',g.terminal_reason,
 'transcript',(SELECT jsonb_agg(CASE WHEN e.payload->'entry'->>'kind' IN ('assistant','thinking') THEN (e.payload->'entry')||jsonb_build_object('generationId',e.generation_id,'generationSeqStart',e.generation_seq,'generationSeqEnd',e.generation_seq) ELSE e.payload->'entry' END ORDER BY e.generation_seq)
 FROM chat_generation_events e WHERE e.org_id=m.org_id AND e.generation_id=g.id AND e.assistant_message_id=m.id AND e.event_kind='transcript' AND (g.accepted_through_seq IS NULL OR e.generation_seq<=g.accepted_through_seq) AND jsonb_typeof(e.payload->'entry')='object'))::text
FROM chat_messages m JOIN LATERAL (
 SELECT g.* FROM chat_generation_events e JOIN chat_generations g ON g.org_id=e.org_id AND g.id=e.generation_id
 WHERE e.org_id=m.org_id AND e.assistant_message_id=m.id AND g.conversation_id=m.conversation_id
 ORDER BY g.created_at DESC,e.recorded_at DESC,e.generation_seq DESC,e.generation_id DESC LIMIT 1
) g ON true WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid AND m.role='assistant'

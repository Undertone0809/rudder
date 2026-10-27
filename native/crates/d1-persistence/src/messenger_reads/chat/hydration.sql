SELECT jsonb_build_object(
'id',c.id,'lastReadAt',s.last_read_at,'pinnedAt',s.pinned_at,
'unreadCount',(SELECT count(*) FROM chat_messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.superseded_at IS NULL AND m.role<>'user' AND (btrim(m.body)<>'' OR m.kind<>'message' OR m.approval_id IS NOT NULL) AND m.created_at>s.last_read_at AND NOT EXISTS(SELECT 1 FROM agent_integration_chat_bindings b WHERE b.org_id=c.org_id AND b.conversation_id=c.id)),
'pendingProposal',EXISTS(SELECT 1 FROM chat_messages m JOIN approvals a ON a.org_id=m.org_id AND a.id=m.approval_id WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.superseded_at IS NULL AND a.status='pending'),
'latestReplyBody',(SELECT m.body FROM chat_messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.superseded_at IS NULL AND m.role<>'user' AND btrim(m.body)<>'' ORDER BY m.created_at DESC,m.id DESC LIMIT 1),
'latestUserBody',(SELECT m.body FROM chat_messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.superseded_at IS NULL AND m.role='user' AND m.kind='message' AND btrim(m.body)<>'' ORDER BY m.created_at DESC,m.id DESC LIMIT 1),
'userMessageCount',(SELECT count(*) FROM chat_messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.superseded_at IS NULL AND m.role='user' AND m.kind='message' AND btrim(m.body)<>''),
'activeGenerationId',(SELECT g.id FROM chat_generations g WHERE g.org_id=c.org_id AND g.conversation_id=c.id AND g.status IN ('starting','active','running','waiting_for_network','tool_busy','closing','stop_requested','stopping') ORDER BY g.started_at DESC,g.created_at DESC LIMIT 1)
)::text FROM chat_conversations c LEFT JOIN chat_conversation_user_states s ON s.org_id=c.org_id AND s.conversation_id=c.id AND s.user_id=$2
WHERE c.org_id=$1::uuid AND c.id::text IN (SELECT jsonb_array_elements_text($3::jsonb))
AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$2)

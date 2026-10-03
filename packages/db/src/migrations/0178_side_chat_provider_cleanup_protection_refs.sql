ALTER TABLE "side_chat_provider_cleanup_intents"
	ADD COLUMN "protection_refs_json" jsonb DEFAULT '{"version":1,"bindingIds":[],"segmentIds":[],"conversationIds":[],"runIds":[],"providerSessionIds":[],"retentionResourceRefs":[],"sourceAliasRefs":[]}'::jsonb NOT NULL;

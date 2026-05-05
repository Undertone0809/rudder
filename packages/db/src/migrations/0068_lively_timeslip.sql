DROP INDEX "chat_attachments_asset_uq";--> statement-breakpoint
CREATE INDEX "chat_attachments_asset_idx" ON "chat_attachments" USING btree ("asset_id");

-- Platform delivery idempotency key (e.g. Feishu `message:<message_id>` and
-- `recall:<message_id>`). NULL for platforms that do not need it; SQLite treats
-- NULLs as distinct, so existing rows are unaffected by the unique index.
ALTER TABLE `events` ADD `dedup_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `events_chat_dedup_idx` ON `events` (`chat_id`,`dedup_key`);

CREATE TABLE `memory_cursors` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`cursor_ms` integer DEFAULT 0 NOT NULL,
	`last_run_ms` integer,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_chat_received_idx` ON `events` (`chat_id`,`received_at`);
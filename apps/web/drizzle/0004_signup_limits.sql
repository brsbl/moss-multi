CREATE TABLE `signup_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `signup_limits_window_idx` ON `signup_limits` (`window_start`);--> statement-breakpoint
DROP INDEX `agents_owner_idx`;--> statement-breakpoint
CREATE INDEX `agents_owner_idx` ON `agents` (`owner_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `docs_created_by_idx` ON `docs` (`created_by`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `feedback_user_idx` ON `feedback` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `folders_created_by_idx` ON `folders` (`created_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `share_links_created_by_idx` ON `share_links` (`created_by`,`created_at`);
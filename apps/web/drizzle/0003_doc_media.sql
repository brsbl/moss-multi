CREATE TABLE `doc_media` (
	`doc_id` text NOT NULL,
	`filename` text NOT NULL,
	`version_id` text,
	`content_hash` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`doc_id`, `filename`),
	FOREIGN KEY (`doc_id`) REFERENCES `docs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `asset_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`content_hash`) REFERENCES `content_objects`(`hash`) ON UPDATE no action ON DELETE no action
);

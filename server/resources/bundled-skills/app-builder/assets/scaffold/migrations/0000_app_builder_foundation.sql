CREATE TABLE `contacts` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `email` text NOT NULL,
  `company` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'new' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_uq` ON `contacts` (`email`);
--> statement-breakpoint
CREATE TABLE `jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `payload_json` text DEFAULT '{}' NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `catch_up_policy` text DEFAULT 'prompt' NOT NULL,
  `scheduled_for` integer NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_key_uq` ON `jobs` (`idempotency_key`);

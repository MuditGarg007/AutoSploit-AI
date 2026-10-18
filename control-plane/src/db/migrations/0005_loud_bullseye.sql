ALTER TABLE "github_tokens" ADD COLUMN "refresh_ciphertext" text;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN "access_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN "refresh_expires_at" timestamp;
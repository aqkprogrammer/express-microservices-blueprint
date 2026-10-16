-- CreateTable
CREATE TABLE "user_profiles" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "roles" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "status_reason" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_messages" (
    "consumer" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("consumer","message_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_email_key" ON "user_profiles"("email");

-- CreateIndex
CREATE INDEX "user_profiles_status_created_at_idx" ON "user_profiles"("status", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events"("published_at");

-- CreateIndex
CREATE INDEX "processed_messages_processed_at_idx" ON "processed_messages"("processed_at");


-- Integrity constraints Prisma's schema language cannot express
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_status_check" CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED')),
  ADD CONSTRAINT "outbox_events_attempts_check" CHECK (attempts >= 0);

ALTER TABLE "user_profiles"
  ADD CONSTRAINT "user_profiles_status_check" CHECK (status IN ('active', 'suspended', 'closed')),
  ADD CONSTRAINT "user_profiles_locale_check" CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$');

CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Trigram indexes back the case-insensitive admin search on email and display name.
CREATE INDEX "user_profiles_email_trgm_idx" ON "user_profiles" USING gin (email gin_trgm_ops);
CREATE INDEX "user_profiles_display_name_trgm_idx" ON "user_profiles" USING gin (display_name gin_trgm_ops);

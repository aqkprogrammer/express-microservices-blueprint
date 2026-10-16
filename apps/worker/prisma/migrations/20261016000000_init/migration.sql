-- CreateTable
CREATE TABLE "dead_letters" (
    "id" UUID NOT NULL,
    "message_id" TEXT NOT NULL,
    "original_queue" TEXT NOT NULL,
    "original_exchange" TEXT,
    "routing_key" TEXT NOT NULL,
    "event_type" TEXT,
    "reason" TEXT NOT NULL,
    "last_error" TEXT,
    "correlation_id" TEXT,
    "body" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ARCHIVED',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "replay_count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,

    CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" BIGSERIAL NOT NULL,
    "task" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dead_letters_status_last_seen_at_idx" ON "dead_letters"("status", "last_seen_at");

-- CreateIndex
CREATE INDEX "dead_letters_original_queue_status_idx" ON "dead_letters"("original_queue", "status");

-- CreateIndex
CREATE UNIQUE INDEX "dead_letters_message_id_original_queue_key" ON "dead_letters"("message_id", "original_queue");

-- CreateIndex
CREATE INDEX "job_runs_task_started_at_idx" ON "job_runs"("task", "started_at");



ALTER TABLE "dead_letters"
  ADD CONSTRAINT "dead_letters_status_check" CHECK (status IN ('ARCHIVED', 'REPLAYED', 'DISCARDED')),
  ADD CONSTRAINT "dead_letters_body_size_check" CHECK (octet_length(body) <= 1048576);

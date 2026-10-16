-- CreateTable
CREATE TABLE "audit_records" (
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "producer" TEXT NOT NULL,
    "subject_id" TEXT,
    "actor_id" TEXT,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB NOT NULL,

    CONSTRAINT "audit_records_pkey" PRIMARY KEY ("event_id")
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
CREATE INDEX "audit_records_event_type_occurred_at_idx" ON "audit_records"("event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_records_subject_id_occurred_at_idx" ON "audit_records"("subject_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_records_correlation_id_idx" ON "audit_records"("correlation_id");

-- CreateIndex
CREATE INDEX "audit_records_occurred_at_idx" ON "audit_records"("occurred_at");

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

ALTER TABLE "audit_records"
  ADD CONSTRAINT "audit_records_category_check" CHECK (category IN ('security', 'business', 'operations'));

-- Append-only: the application role may insert and delete (retention) but never update audit rows.
CREATE FUNCTION audit_records_block_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_records is append-only';
END;
$$;
CREATE TRIGGER audit_records_no_update BEFORE UPDATE ON "audit_records"
  FOR EACH ROW EXECUTE FUNCTION audit_records_block_update();

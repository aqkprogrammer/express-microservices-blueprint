-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "method_token" TEXT NOT NULL,
    "provider_reference" TEXT,
    "failure_reason" TEXT,
    "authorization_attempts" INTEGER NOT NULL DEFAULT 0,
    "captured_cents" INTEGER NOT NULL DEFAULT 0,
    "refunded_cents" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "last_attempt_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" BIGSERIAL NOT NULL,
    "payment_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("scope","key")
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
CREATE UNIQUE INDEX "payments_order_id_key" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_status_last_attempt_at_idx" ON "payments"("status", "last_attempt_at");

-- CreateIndex
CREATE INDEX "payments_customer_id_created_at_idx" ON "payments"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_events_payment_id_created_at_idx" ON "payment_events"("payment_id", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_records_created_at_idx" ON "idempotency_records"("created_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events"("published_at");

-- CreateIndex
CREATE INDEX "processed_messages_processed_at_idx" ON "processed_messages"("processed_at");

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity constraints Prisma's schema language cannot express
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_status_check" CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED')),
  ADD CONSTRAINT "outbox_events_attempts_check" CHECK (attempts >= 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_status_check"
    CHECK (status IN ('PENDING', 'PROCESSING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'VOIDED', 'REFUNDED')),
  ADD CONSTRAINT "payments_amount_check" CHECK (amount_cents >= 0),
  ADD CONSTRAINT "payments_captured_check" CHECK (captured_cents >= 0 AND captured_cents <= amount_cents),
  ADD CONSTRAINT "payments_refunded_check" CHECK (refunded_cents >= 0 AND refunded_cents <= captured_cents),
  -- Defence in depth: method tokens are simulator tokens, never anything shaped like a card number.
  ADD CONSTRAINT "payments_method_token_check" CHECK (method_token ~ '^sim_[a-z_]+$');

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_state_check" CHECK (state IN ('IN_PROGRESS', 'COMPLETED'));

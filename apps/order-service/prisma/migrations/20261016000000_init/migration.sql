-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "payment_method_token" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "cancellation_reason" TEXT,
    "review_reason" TEXT,
    "payment_id" UUID,
    "reservation_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "line_total_cents" INTEGER NOT NULL,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("order_id","product_id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" BIGSERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL,
    "causation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_sagas" (
    "order_id" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "deadline_at" TIMESTAMPTZ(3),
    "payment_attempts" INTEGER NOT NULL DEFAULT 0,
    "timeout_checks" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_sagas_pkey" PRIMARY KEY ("order_id")
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
CREATE INDEX "orders_customer_id_created_at_idx" ON "orders"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_customer_id_idempotency_key_key" ON "orders"("customer_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "order_status_history_order_id_created_at_idx" ON "order_status_history"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "order_sagas_step_deadline_at_idx" ON "order_sagas"("step", "deadline_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events"("published_at");

-- CreateIndex
CREATE INDEX "processed_messages_processed_at_idx" ON "processed_messages"("processed_at");

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_sagas" ADD CONSTRAINT "order_sagas_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity constraints Prisma's schema language cannot express
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_status_check" CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED')),
  ADD CONSTRAINT "outbox_events_attempts_check" CHECK (attempts >= 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_status_check"
    CHECK (status IN ('PENDING', 'AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'REQUIRES_REVIEW')),
  ADD CONSTRAINT "orders_total_check" CHECK (total_cents >= 0);

ALTER TABLE "order_lines"
  ADD CONSTRAINT "order_lines_quantity_check" CHECK (quantity > 0),
  ADD CONSTRAINT "order_lines_total_check" CHECK (line_total_cents = quantity * unit_price_cents);

ALTER TABLE "order_sagas"
  ADD CONSTRAINT "order_sagas_step_check"
    CHECK (step IN ('AWAITING_INVENTORY', 'AWAITING_PAYMENT', 'COMPLETED', 'COMPENSATED', 'REQUIRES_REVIEW'));

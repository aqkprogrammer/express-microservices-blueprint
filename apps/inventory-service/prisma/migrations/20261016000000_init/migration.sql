-- CreateTable
CREATE TABLE "inventory_items" (
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_lines" (
    "reservation_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "reservation_lines_pkey" PRIMARY KEY ("reservation_id","product_id")
);

-- CreateTable
CREATE TABLE "stock_adjustments" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "inventory_items_sku_idx" ON "inventory_items"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_order_id_key" ON "reservations"("order_id");

-- CreateIndex
CREATE INDEX "reservations_status_expires_at_idx" ON "reservations"("status", "expires_at");

-- CreateIndex
CREATE INDEX "stock_adjustments_product_id_created_at_idx" ON "stock_adjustments"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events"("published_at");

-- CreateIndex
CREATE INDEX "processed_messages_processed_at_idx" ON "processed_messages"("processed_at");

-- AddForeignKey
ALTER TABLE "reservation_lines" ADD CONSTRAINT "reservation_lines_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inventory_items"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity constraints Prisma's schema language cannot express
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_status_check" CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED')),
  ADD CONSTRAINT "outbox_events_attempts_check" CHECK (attempts >= 0);

-- Overselling protection: the database rejects any update that would make stock negative
-- or reserve more than is on hand, regardless of application logic.
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_on_hand_check" CHECK (on_hand >= 0),
  ADD CONSTRAINT "inventory_items_reserved_check" CHECK (reserved >= 0 AND reserved <= on_hand);

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_status_check"
  CHECK (status IN ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED', 'REJECTED', 'CANCELLED'));

ALTER TABLE "reservation_lines" ADD CONSTRAINT "reservation_lines_quantity_check" CHECK (quantity > 0);
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_delta_check" CHECK (delta <> 0);

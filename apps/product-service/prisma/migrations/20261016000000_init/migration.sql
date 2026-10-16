-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "available_quantity" INTEGER NOT NULL DEFAULT 0,
    "availability_updated_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE INDEX "products_status_category_idx" ON "products"("status", "category");

-- CreateIndex
CREATE INDEX "products_price_cents_idx" ON "products"("price_cents");

-- CreateIndex
CREATE INDEX "products_created_at_idx" ON "products"("created_at");

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

ALTER TABLE "products"
  ADD CONSTRAINT "products_price_check" CHECK (price_cents >= 0),
  ADD CONSTRAINT "products_status_check" CHECK (status IN ('draft', 'active', 'discontinued')),
  ADD CONSTRAINT "products_available_check" CHECK (available_quantity >= 0),
  ADD CONSTRAINT "products_currency_check" CHECK (currency ~ '^[A-Z]{3}$');

-- Trigram index for case-insensitive name search (pg_trgm is a trusted extension).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "products_name_trgm_idx" ON "products" USING gin (name gin_trgm_ops);

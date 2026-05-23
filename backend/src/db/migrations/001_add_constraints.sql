-- Migration: production schema fixes (For production deployment concerns)
-- Apply to existing databases where schema.sql cannot be re-run cleanly.

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_price_check,
  ADD CONSTRAINT products_price_check CHECK (price >= 0.01);

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_product_id_fkey,
  ADD CONSTRAINT order_items_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_order_id_product_id_unique
    UNIQUE (order_id, product_id);

ALTER TABLE payments
  ADD CONSTRAINT payments_idempotency_key_unique
    UNIQUE (idempotency_key);

ALTER TABLE payments
  ADD CONSTRAINT payments_provider_txn_id_length_check
    CHECK (char_length(provider_txn_id) <= 255);

ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_provider_event_id_unique
    UNIQUE (provider_event_id);

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);

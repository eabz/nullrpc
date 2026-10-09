-- Manual refunds: a withdrawal leaves a refund
-- owed (`refund_cents`); an admin sends it from the treasury (Trezor) and records the
-- transaction, verified on-chain, in `refund_tx` and `refunded_at`.
ALTER TABLE invoices ADD COLUMN refunded_at INTEGER;
CREATE INDEX invoices_withdrawn ON invoices(withdrawn_at) WHERE withdrawn_at IS NOT NULL;
CREATE UNIQUE INDEX invoices_refund_tx ON invoices(refund_tx) WHERE refund_tx IS NOT NULL;

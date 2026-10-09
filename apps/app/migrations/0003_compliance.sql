-- Compliance: Terms acceptance, sanctions screening, billing details,
-- taxed and numbered invoices, and the consumer right of withdrawal.

-- Terms of Service: the version the account accepted, and when.
ALTER TABLE accounts ADD COLUMN terms_version TEXT;
ALTER TABLE accounts ADD COLUMN terms_accepted_at INTEGER;
-- Sanctions: last screening of the address (Chainalysis oracle), and a suspension that
-- refuses sign-in, the API and every API key of the account.
ALTER TABLE accounts ADD COLUMN screened_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN suspended_at INTEGER;
ALTER TABLE accounts ADD COLUMN suspended_reason TEXT;
-- Billing details for invoices (JSON: name, country, tax_id, address, business).
ALTER TABLE accounts ADD COLUMN billing TEXT;

-- usd_cents stays the total charged; subtotal_cents + tax_cents = usd_cents.
ALTER TABLE invoices ADD COLUMN subtotal_cents INTEGER;
ALTER TABLE invoices ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN tax TEXT;              -- JSON: rule, rate, label, note
ALTER TABLE invoices ADD COLUMN buyer TEXT;            -- JSON: billing details and evidence at creation
ALTER TABLE invoices ADD COLUMN consent TEXT;          -- the checkout acknowledgement shown and accepted
ALTER TABLE invoices ADD COLUMN number TEXT;           -- sequential, assigned when paid (NR-000001)
ALTER TABLE invoices ADD COLUMN withdrawn_at INTEGER;  -- consumer withdrawal
ALTER TABLE invoices ADD COLUMN refund_cents INTEGER;  -- owed after a withdrawal
ALTER TABLE invoices ADD COLUMN refund_tx TEXT;        -- set by hand once refunded
CREATE UNIQUE INDEX invoices_number ON invoices(number) WHERE number IS NOT NULL;

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) WITHOUT ROWID;
INSERT INTO counters (name, value) VALUES ('invoice', 0);

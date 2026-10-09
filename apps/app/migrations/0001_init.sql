-- nullrpc platform: accounts, API keys, usage, invoices.
-- Money is integer nano-USD (1e-9 USD); times are Unix milliseconds.

CREATE TABLE accounts (
  address TEXT PRIMARY KEY,               -- lowercase 0x address (wallet sign-in)
  created_at INTEGER NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  paid_until INTEGER NOT NULL DEFAULT 0,  -- paid plans fall back to free after this
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  period_units INTEGER NOT NULL DEFAULT 0,
  balance_nano INTEGER NOT NULL DEFAULT 0 -- prepaid balance for overage
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,                    -- 32 hex chars; the key is derived (src/keys.ts)
  address TEXT NOT NULL REFERENCES accounts(address),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX api_keys_address ON api_keys(address);

-- Hourly usage per key, written by the RPC Workers' metering flushes.
CREATE TABLE usage (
  key_id TEXT NOT NULL,
  hour INTEGER NOT NULL,                  -- Unix hour (ms / 3,600,000)
  address TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, hour)
) WITHOUT ROWID;
CREATE INDEX usage_address ON usage(address, hour);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES accounts(address),
  kind TEXT NOT NULL,                     -- plan | topup
  plan TEXT,
  months INTEGER,
  usd_cents INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  asset TEXT NOT NULL,                    -- USDC | ETH
  amount TEXT NOT NULL,                   -- base units (decimal string)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',    -- open | pending | paid | expired | failed
  tx_hash TEXT UNIQUE,
  paid_at INTEGER,
  note TEXT
);
CREATE INDEX invoices_address ON invoices(address, created_at);
CREATE INDEX invoices_pending ON invoices(status) WHERE status = 'pending';

-- Sign-in nonces are single use.
CREATE TABLE used_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

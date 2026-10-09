-- Sign-up anti-abuse, admin tooling and the daily anomaly report.
-- No IP address is stored: client networks are keyed hashes (src/gate.ts `networkId`).

-- Free-plan wallet-activity gate: the result of the last on-chain check of the wallet.
--   NULL      accounts created before this migration (treated as passed)
--   passed    nonce or balance over the thresholds: Free plan
--   failed    no on-chain history: plan 'unverified' (0 included credits) until a payment
--   pending   the check could not run (RPC unavailable): 'unverified', re-checked on demand
--   capped    passed, but the day's cap of new free accounts was reached: 'unverified'
ALTER TABLE accounts ADD COLUMN wallet_check TEXT;
ALTER TABLE accounts ADD COLUMN wallet_checked_at INTEGER;
ALTER TABLE accounts ADD COLUMN wallet_nonce INTEGER;
ALTER TABLE accounts ADD COLUMN wallet_balance_wei TEXT;
-- Keyed hash of the client network (IPv4 or IPv6 /64) the account signed up from.
ALTER TABLE accounts ADD COLUMN signup_net TEXT;
-- The last admin note (the full history is in admin_log).
ALTER TABLE accounts ADD COLUMN admin_note TEXT;
CREATE INDEX accounts_signup_net ON accounts(signup_net) WHERE signup_net IS NOT NULL;

-- New accounts per UTC day (YYYYMMDD) and client network; net = '' is the day's total.
-- `accounts` counts every new account, `free` those granted the Free plan.
CREATE TABLE signup_days (
  day INTEGER NOT NULL,
  net TEXT NOT NULL,
  accounts INTEGER NOT NULL DEFAULT 0,
  free INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, net)
) WITHOUT ROWID;

-- The daily anomaly report (src/report.ts), one row per UTC day; kept 90 days.
CREATE TABLE anomaly_reports (
  day INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  report TEXT NOT NULL                    -- JSON
);

-- Admin actions (suspensions, plan changes, notes) and automatic suspensions.
CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  target TEXT NOT NULL,                   -- account:<address> | key:<id>
  action TEXT NOT NULL,                   -- JSON: the change applied
  note TEXT
);
CREATE INDEX admin_log_target ON admin_log(target, at);

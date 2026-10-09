-- Usage enforcement: credit leases, the shared
-- per-network cap for non-paying traffic, keyless aggregate caps, and suspension flags.
-- No IP address is stored: networks and /24 blocks are keyed hashes computed by the RPC Workers,
-- ASNs are plain numbers.

-- Suspension. An account is suspended when `suspended_at` (migration 0003: sanctions, abuse) is
-- set or `suspended` = 1; a key when its `suspended` = 1. Either makes the entitlement and the
-- lease answer "suspended" (RPC: 403 -32001 "Account suspended: contact support").
ALTER TABLE accounts ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;

-- Credit leases: credits an RPC Worker isolate may serve for one subject before renewing.
-- `reserved` is the lease's outstanding reservation (0 once released); `reported_*` are the
-- cumulative totals the isolate reported, so a retried renewal is never counted twice.
-- `targets` is the sorted list of counters the lease reserves against (see lease_targets).
CREATE TABLE leases (
  id TEXT PRIMARY KEY,                    -- 32 hex
  subject TEXT NOT NULL,                  -- key:<id> | anon:<id> (plus @<net> for Free keys)
  targets TEXT NOT NULL,
  reserved INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  reported_units INTEGER NOT NULL DEFAULT 0,
  reported_requests INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX leases_expiring ON leases(expires_at) WHERE reserved > 0;
CREATE INDEX leases_old ON leases(expires_at);

CREATE TABLE lease_targets (
  lease_id TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY (lease_id, target)
) WITHOUT ROWID;

-- Counters: `reserved` for every lease target (acct:<address>, net:<id>:<YYYYMM>,
-- block:<id>:<YYYYMM>, asn:<n>:<YYYYMM>, day:<YYYYMMDD>), and `used` for the keyless aggregates
-- (block, asn, day; an account's use is accounts.period_units, a network's public_usage.units).
-- Rows past `expires_at` with nothing reserved are deleted by the cron.
CREATE TABLE usage_buckets (
  id TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

-- public_usage.units now counts all non-paying use of the network (keyless and Free keys, the
-- shared FREE_NETWORK_CAP); key_units is the Free-key share of it.
ALTER TABLE public_usage ADD COLUMN key_units INTEGER NOT NULL DEFAULT 0;

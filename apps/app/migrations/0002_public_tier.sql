-- Public tier (no API key): monthly usage per client network.
-- `id` is a keyed hash of the IPv4 address or IPv6 /64 computed by the RPC Workers; no IP
-- address is stored. `month` is UTC YYYYMM. Rows older than the previous month are deleted.
CREATE TABLE public_usage (
  id TEXT NOT NULL,
  month INTEGER NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, month)
) WITHOUT ROWID;

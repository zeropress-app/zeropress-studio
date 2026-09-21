CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  occurred_at TEXT NOT NULL,
  action TEXT NOT NULL,
  category TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'partial', 'unchanged', 'unknown')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'operations')),
  actor_id TEXT,
  actor_name TEXT,
  actor_email TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT,
  metadata_json TEXT NOT NULL,
  ip_address TEXT,
  ip_recorded_at TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  timezone TEXT,
  asn INTEGER,
  organization TEXT
);
CREATE INDEX audit_logs_time_idx ON audit_logs (occurred_at DESC, id DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, occurred_at DESC, id DESC);
CREATE INDEX audit_logs_ip_idx ON audit_logs (ip_hash, occurred_at DESC, id DESC);
CREATE INDEX audit_logs_raw_ip_idx ON audit_logs (ip_recorded_at) WHERE ip_address IS NOT NULL;

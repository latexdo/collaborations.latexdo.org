CREATE TABLE IF NOT EXISTS project_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('file', 'directory')),
  content TEXT NOT NULL DEFAULT '',
  y_update TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presence (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  current_file TEXT,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collaborators (
  client_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS collaborators_active_role_idx
  ON collaborators (revoked, role);

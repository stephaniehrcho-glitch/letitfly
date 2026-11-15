-- HitTheGrid: accounts, email login codes, sessions, and the event document store.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Every piece of event data is a JSON document addressed by a path such as
-- "event/main", "rr/<userId>" or "private/library". Deleted documents keep a
-- row with data = NULL so polling clients learn about the deletion.
CREATE TABLE IF NOT EXISTS docs (
  path        TEXT PRIMARY KEY,
  coll        TEXT NOT NULL,
  data        TEXT,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
CREATE INDEX IF NOT EXISTS docs_updated ON docs(updated_at);

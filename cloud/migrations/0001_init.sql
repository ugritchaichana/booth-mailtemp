CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  date_header TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL,
  stored INTEGER NOT NULL,
  attachments INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  chunks INTEGER NOT NULL
);
CREATE INDEX messages_created ON messages (created);

CREATE TABLE recipients (
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  local TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (message_id, address)
);
CREATE INDEX recipients_local ON recipients (local, message_id);

CREATE TABLE chunks (
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (message_id, seq)
);
CREATE INDEX chunks_created ON chunks (created);

CREATE TABLE users (username TEXT PRIMARY KEY, created INTEGER NOT NULL);
CREATE TABLE hidden (username TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (username, id));
CREATE TABLE reads (username TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (username, id));

CREATE TABLE sessions (id TEXT PRIMARY KEY, active TEXT, created INTEGER NOT NULL, seen INTEGER NOT NULL);
CREATE INDEX sessions_seen ON sessions (seen);
CREATE TABLE session_accounts (
  session TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (session, username)
);
CREATE INDEX session_accounts_order ON session_accounts (session, position);

CREATE TABLE rate_hits (key TEXT NOT NULL, window INTEGER NOT NULL, hits INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (key, window));

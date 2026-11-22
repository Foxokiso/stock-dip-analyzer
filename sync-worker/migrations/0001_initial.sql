-- Initial schema for Dip Analyzer PRO GitHub-authenticated cloud sync.
-- Per-user memory caps (settings bytes, watchlist items, saved tickets) are
-- enforced by the Worker so every account stays within a predictable footprint.

CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	github_id INTEGER NOT NULL UNIQUE,
	github_login TEXT NOT NULL,
	avatar_url TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_requests (
	state TEXT PRIMARY KEY,
	poll_hash TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
	user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_requests_expires ON auth_requests(expires_at);

CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_settings (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	payload TEXT NOT NULL,
	revision INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlists (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	symbol TEXT NOT NULL,
	notes TEXT,
	added_at TEXT NOT NULL,
	PRIMARY KEY (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS saved_tickets (
	id TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	symbol TEXT NOT NULL,
	label TEXT NOT NULL,
	broker TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_saved_tickets_user ON saved_tickets(user_id, updated_at DESC);

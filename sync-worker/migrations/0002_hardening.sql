-- Hardens auth handshakes (user-code confirmation, browser binding cookie,
-- replay/terminal failure states, IP throttling) and adds revision + tombstone
-- concurrency control to watchlists and saved tickets.

DROP TABLE IF EXISTS auth_requests;
CREATE TABLE auth_requests (
	state TEXT PRIMARY KEY,
	poll_hash TEXT NOT NULL,
	user_code_hash TEXT NOT NULL,
	browser_hash TEXT,
	ip_hash TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'authorized', 'exchanging', 'ready', 'failed')),
	attempts INTEGER NOT NULL DEFAULT 0,
	user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
	error_message TEXT,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX idx_auth_requests_expires ON auth_requests(expires_at);
CREATE INDEX idx_auth_requests_ip ON auth_requests(ip_hash, status, expires_at);

DROP TABLE IF EXISTS watchlists;
CREATE TABLE user_watchlists (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	payload TEXT NOT NULL,
	item_count INTEGER NOT NULL,
	revision INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT NOT NULL
);

DROP TABLE IF EXISTS saved_tickets;
CREATE TABLE saved_tickets (
	id TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	symbol TEXT NOT NULL,
	label TEXT NOT NULL,
	broker TEXT NOT NULL,
	payload TEXT NOT NULL,
	revision INTEGER NOT NULL DEFAULT 1,
	deleted_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_saved_tickets_user ON saved_tickets(user_id, deleted_at, updated_at DESC);

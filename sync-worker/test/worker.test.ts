import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "../src/router.ts";
import { MEMORY_LIMITS } from "../src/limits.ts";

const migrationSql = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");

/** Minimal D1Database adapter backed by Node's built-in SQLite for deterministic tests. */
function createTestDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(migrationSql);

	function makeStatement(sql: string, bound: unknown[] = []) {
		const prepared = sqlite.prepare(sql);
		return {
			_sql: sql,
			_bound: bound,
			bind(...params: unknown[]) {
				return makeStatement(sql, params);
			},
			async first<T = Record<string, unknown>>() {
				const row = prepared.get(...bound) as T | undefined;
				return row ?? null;
			},
			async all<T = Record<string, unknown>>() {
				const results = prepared.all(...bound) as T[];
				return { results, success: true, meta: { changes: 0 } };
			},
			async run() {
				const info = prepared.run(...bound);
				return { results: [], success: true, meta: { changes: Number(info.changes ?? 0) } };
			},
		};
	}

	return {
		sqlite,
		prepare(sql: string) {
			return makeStatement(sql);
		},
		async batch(statements: ReturnType<typeof makeStatement>[]) {
			sqlite.exec("BEGIN");
			try {
				const out = [];
				for (const stmt of statements) {
					out.push(await stmt.run());
				}
				sqlite.exec("COMMIT");
				return out;
			} catch (err) {
				sqlite.exec("ROLLBACK");
				throw err;
			}
		},
	};
}

function createTestEnv(overrides: Partial<Record<"GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET", string>> = {}) {
	const db = createTestDb();
	const pending: Promise<unknown>[] = [];
	const env = {
		DB: db,
		APP_NAME: "Dip Analyzer PRO",
		GITHUB_CLIENT_ID: "gh-client-id",
		GITHUB_CLIENT_SECRET: "gh-client-secret",
		...overrides,
	} as unknown as Env;
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(Promise.resolve(promise));
		},
	} as unknown as ExecutionContext;
	return {
		db,
		env,
		ctx,
		async flush() {
			await Promise.all(pending.splice(0));
		},
	};
}

async function signInUser(
	{ env, ctx }: ReturnType<typeof createTestEnv>,
	ghUser: { id: number; login: string; avatar_url?: string },
) {
	const startRes = await handleRequest(new Request("https://sync.example/auth/start", { method: "POST" }), env, ctx);
	assert.equal(startRes.status, 201);
	const start = (await startRes.json()) as { state: string; pollToken: string; authorizeUrl: string; callbackUrl: string };

	const loginRes = await handleRequest(new Request(start.authorizeUrl), env, ctx);
	assert.equal(loginRes.status, 302);
	const location = new URL(loginRes.headers.get("Location")!);
	assert.equal(location.origin, "https://github.com");
	assert.equal(location.searchParams.get("state"), start.state);

	const pendingPoll = await handleRequest(
		new Request("https://sync.example/auth/poll", {
			method: "POST",
			body: JSON.stringify({ state: start.state, pollToken: start.pollToken }),
		}),
		env,
		ctx,
	);
	assert.equal(pendingPoll.status, 202);

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (target === "https://github.com/login/oauth/access_token") {
			return Response.json({ access_token: "gh-access-token" });
		}
		if (target === "https://api.github.com/user") {
			return Response.json({ avatar_url: null, ...ghUser });
		}
		throw new Error(`Unexpected fetch in test: ${target}`);
	}) as typeof fetch;

	try {
		const callbackRes = await handleRequest(
			new Request(`https://sync.example/auth/callback?code=test-code&state=${start.state}`),
			env,
			ctx,
		);
		assert.equal(callbackRes.status, 200);
		assert.match(await callbackRes.text(), new RegExp(`Signed in as @${ghUser.login}`));
	} finally {
		globalThis.fetch = originalFetch;
	}

	const pollRes = await handleRequest(
		new Request("https://sync.example/auth/poll", {
			method: "POST",
			body: JSON.stringify({ state: start.state, pollToken: start.pollToken }),
		}),
		env,
		ctx,
	);
	assert.equal(pollRes.status, 200);
	const poll = (await pollRes.json()) as { status: string; token: string; user: { id: string; githubLogin: string } };
	assert.equal(poll.status, "authenticated");
	assert.equal(poll.user.githubLogin, ghUser.login);

	// The handshake is strictly single-use.
	const replayRes = await handleRequest(
		new Request("https://sync.example/auth/poll", {
			method: "POST",
			body: JSON.stringify({ state: start.state, pollToken: start.pollToken }),
		}),
		env,
		ctx,
	);
	assert.equal(replayRes.status, 404);

	return poll;
}

test("health reports D1 connectivity and whether GitHub OAuth secrets are configured", async () => {
	const unconfigured = createTestEnv({ GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" });
	const healthA = await handleRequest(new Request("https://sync.example/health"), unconfigured.env, unconfigured.ctx);
	assert.equal(healthA.status, 200);
	assert.deepEqual(await healthA.json(), {
		ok: true,
		service: "stock-dip-analyzer-sync",
		db: true,
		oauthConfigured: false,
		callbackUrl: "https://sync.example/auth/callback",
		limits: MEMORY_LIMITS,
	});

	const startBlocked = await handleRequest(new Request("https://sync.example/auth/start", { method: "POST" }), unconfigured.env, unconfigured.ctx);
	assert.equal(startBlocked.status, 503);

	const configured = createTestEnv();
	const healthB = await handleRequest(new Request("https://sync.example/health"), configured.env, configured.ctx);
	assert.equal(((await healthB.json()) as { oauthConfigured: boolean }).oauthConfigured, true);
});

test("GitHub OAuth handshake issues a bearer token, escapes errors safely, and supports logout", async () => {
	const harness = createTestEnv();

	// Escapes HTML from callback error descriptions.
	const xssRes = await handleRequest(
		new Request("https://sync.example/auth/callback?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C/script%3E"),
		harness.env,
		harness.ctx,
	);
	assert.equal(xssRes.status, 400);
	const html = await xssRes.text();
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

	// Wrong poll token is refused with 403.
	const startRes = await handleRequest(new Request("https://sync.example/auth/start", { method: "POST" }), harness.env, harness.ctx);
	const start = (await startRes.json()) as { state: string };
	const badPoll = await handleRequest(
		new Request("https://sync.example/auth/poll", {
			method: "POST",
			body: JSON.stringify({ state: start.state, pollToken: "0".repeat(64) }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(badPoll.status, 403);

	const auth = await signInUser(harness, { id: 42, login: "foxokiso" });
	const me = await handleRequest(
		new Request("https://sync.example/api/me", { headers: { Authorization: `Bearer ${auth.token}` } }),
		harness.env,
		harness.ctx,
	);
	assert.equal(me.status, 200);
	assert.equal(((await me.json()) as { user: { githubLogin: string } }).user.githubLogin, "foxokiso");
	await harness.flush();

	const logout = await handleRequest(
		new Request("https://sync.example/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${auth.token}` } }),
		harness.env,
		harness.ctx,
	);
	assert.equal(logout.status, 200);

	const afterLogout = await handleRequest(
		new Request("https://sync.example/api/me", { headers: { Authorization: `Bearer ${auth.token}` } }),
		harness.env,
		harness.ctx,
	);
	assert.equal(afterLogout.status, 401);
});

test("settings, watchlist, and saved tickets sync within per-user memory caps and stay isolated across users", async () => {
	const harness = createTestEnv();
	const alice = await signInUser(harness, { id: 1, login: "alice" });
	const bob = await signInUser(harness, { id: 2, login: "bob" });
	const asAlice = { Authorization: `Bearer ${alice.token}` };
	const asBob = { Authorization: `Bearer ${bob.token}` };

	// Settings: optimistic revisions + byte cap.
	const put1 = await handleRequest(
		new Request("https://sync.example/api/settings", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({ settings: { version: 2, appearance: { theme: "theme-pierce27" } }, expectedRevision: 0 }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(put1.status, 200);
	assert.equal(((await put1.json()) as { revision: number }).revision, 1);

	const stale = await handleRequest(
		new Request("https://sync.example/api/settings", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({ settings: { version: 2 }, expectedRevision: 0 }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(stale.status, 409);

	const oversizedSettings = await handleRequest(
		new Request("https://sync.example/api/settings", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({ settings: { big: "a".repeat(MEMORY_LIMITS.maxSettingsBytes) } }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(oversizedSettings.status, 413);

	// Watchlist: normalization, duplicate rejection, and item cap.
	const badWatch = await handleRequest(
		new Request("https://sync.example/api/watchlist", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({ items: [{ symbol: "aapl" }, { symbol: "AAPL" }] }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(badWatch.status, 400);

	const tooManyWatch = await handleRequest(
		new Request("https://sync.example/api/watchlist", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({
				items: Array.from({ length: MEMORY_LIMITS.maxWatchlistItems + 1 }, (_, i) => ({ symbol: `SYM${i}` })),
			}),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(tooManyWatch.status, 413);

	const goodWatch = await handleRequest(
		new Request("https://sync.example/api/watchlist", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({ items: [{ symbol: "brk.b", notes: "Watch support" }, { symbol: "aapl" }] }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(goodWatch.status, 200);

	// Saved tickets: both Alice and Bob can use ticket id "spread-1" independently without collision.
	const ticketBody = (symbol: string) =>
		JSON.stringify({ symbol, label: `${symbol} call spread`, broker: "robinhood", order: { symbol, legs: [] } });
	const aliceTicket = await handleRequest(
		new Request("https://sync.example/api/tickets/spread-1", { method: "PUT", headers: asAlice, body: ticketBody("AAPL") }),
		harness.env,
		harness.ctx,
	);
	const bobTicket = await handleRequest(
		new Request("https://sync.example/api/tickets/spread-1", { method: "PUT", headers: asBob, body: ticketBody("MSFT") }),
		harness.env,
		harness.ctx,
	);
	assert.equal(aliceTicket.status, 201);
	assert.equal(bobTicket.status, 201);

	const aliceSync = await handleRequest(new Request("https://sync.example/api/sync", { headers: asAlice }), harness.env, harness.ctx);
	const syncData = (await aliceSync.json()) as {
		watchlist: Array<{ symbol: string }>;
		savedTickets: Array<{ id: string; symbol: string }>;
		usage: { watchlistCount: number; savedTicketsCount: number };
	};
	assert.deepEqual(syncData.watchlist.map((item) => item.symbol), ["AAPL", "BRK.B"]);
	assert.deepEqual(syncData.savedTickets.map((item) => [item.id, item.symbol]), [["spread-1", "AAPL"]]);
	assert.equal(syncData.usage.watchlistCount, 2);
	assert.equal(syncData.usage.savedTicketsCount, 1);

	const badId = await handleRequest(
		new Request("https://sync.example/api/tickets/%E0%A4%A", { method: "DELETE", headers: asAlice }),
		harness.env,
		harness.ctx,
	);
	assert.equal(badId.status, 400);

	const delRes = await handleRequest(
		new Request("https://sync.example/api/tickets/spread-1", { method: "DELETE", headers: asAlice }),
		harness.env,
		harness.ctx,
	);
	assert.equal(delRes.status, 200);

	// Bob's ticket with the same ID must still be intact.
	const bobSync = await handleRequest(new Request("https://sync.example/api/sync", { headers: asBob }), harness.env, harness.ctx);
	assert.equal(((await bobSync.json()) as { savedTickets: unknown[] }).savedTickets.length, 1);

	await harness.flush();
});

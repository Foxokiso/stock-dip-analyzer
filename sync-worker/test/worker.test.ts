import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "../src/router.ts";
import { MEMORY_LIMITS } from "../src/limits.ts";

const migration1 = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const migration2 = readFileSync(new URL("../migrations/0002_hardening.sql", import.meta.url), "utf8");

/** Minimal D1Database adapter backed by Node's built-in SQLite for deterministic tests. */
function createTestDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(migration1);
	sqlite.exec(migration2);

	function makeStatement(sql: string, bound: unknown[] = []) {
		const prepared = sqlite.prepare(sql);
		return {
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

function extractCookieValue(response: Response, name: string): string {
	const header = response.headers.get("Set-Cookie") ?? "";
	const match = new RegExp(`${name}=([^;]+)`).exec(header);
	assert.ok(match, `expected Set-Cookie for ${name}`);
	return match[1];
}

async function startAndVerifyDevice(
	{ env, ctx }: ReturnType<typeof createTestEnv>,
	ip = "198.51.100.1",
) {
	const startRes = await handleRequest(
		new Request("https://sync.example/auth/start", {
			method: "POST",
			headers: { "CF-Connecting-IP": ip },
		}),
		env,
		ctx,
	);
	assert.equal(startRes.status, 201);
	const start = (await startRes.json()) as {
		state: string;
		pollToken: string;
		userCode: string;
		authorizeUrl: string;
		callbackUrl: string;
	};
	assert.match(start.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

	const promptRes = await handleRequest(new Request(start.authorizeUrl), env, ctx);
	assert.equal(promptRes.status, 200);
	const csp = promptRes.headers.get("Content-Security-Policy") ?? "";
	assert.doesNotMatch(csp, /unsafe-inline/);
	assert.match(csp, /style-src 'self'/);
	const csrfCookie = extractCookieValue(promptRes, "sda_login_csrf");

	const submitRes = await handleRequest(
		new Request("https://sync.example/auth/login", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Cookie: `sda_login_csrf=${csrfCookie}`,
			},
			body: new URLSearchParams({ state: start.state, user_code: start.userCode }).toString(),
		}),
		env,
		ctx,
	);
	assert.equal(submitRes.status, 302);
	const location = new URL(submitRes.headers.get("Location")!);
	assert.equal(location.origin, "https://github.com");
	assert.equal(location.searchParams.get("state"), start.state);
	const bindCookie = extractCookieValue(submitRes, "sda_auth_bind");

	return { start, bindCookie };
}

async function signInUser(
	harness: ReturnType<typeof createTestEnv>,
	ghUser: { id: number; login: string; avatar_url?: string },
	ip = "198.51.100.10",
) {
	const { env, ctx } = harness;
	const { start, bindCookie } = await startAndVerifyDevice(harness, ip);

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
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (target === "https://github.com/login/oauth/access_token") {
			assert.equal(init?.method, "POST");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("Accept"), "application/json");
			assert.equal(headers.get("Content-Type"), "application/json");
			const sent = JSON.parse(String(init?.body)) as Record<string, string>;
			assert.deepEqual(sent, {
				client_id: "gh-client-id",
				client_secret: "gh-client-secret",
				code: "test-code",
				redirect_uri: "https://sync.example/auth/callback",
			});
			return Response.json({ access_token: "gh-access-token" });
		}
		if (target === "https://api.github.com/user") {
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("Authorization"), "Bearer gh-access-token");
			return Response.json({ avatar_url: null, ...ghUser });
		}
		throw new Error(`Unexpected fetch in test: ${target}`);
	}) as typeof fetch;

	try {
		const callbackRes = await handleRequest(
			new Request(`https://sync.example/auth/callback?code=test-code&state=${start.state}`, {
				headers: { Cookie: `sda_auth_bind=${bindCookie}` },
			}),
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

test("health queries D1, reports 503 when D1 fails, and serves stylesheet without unsafe-inline CSP", async () => {
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

	const cssRes = await handleRequest(new Request("https://sync.example/auth/style.css"), unconfigured.env, unconfigured.ctx);
	assert.equal(cssRes.status, 200);
	assert.match(cssRes.headers.get("Content-Type") ?? "", /text\/css/);

	const brokenEnv = {
		DB: {
			prepare() {
				return {
					first() {
						return Promise.reject(new Error("D1 offline"));
					},
				};
			},
		},
		APP_NAME: "Dip Analyzer PRO",
	} as unknown as Env;
	const brokenHealth = await handleRequest(new Request("https://sync.example/health"), brokenEnv, unconfigured.ctx);
	assert.equal(brokenHealth.status, 503);
	assert.deepEqual(await brokenHealth.json(), {
		ok: false,
		service: "stock-dip-analyzer-sync",
		db: false,
		oauthConfigured: false,
		callbackUrl: "https://sync.example/auth/callback",
		limits: MEMORY_LIMITS,
	});

	const startBlocked = await handleRequest(new Request("https://sync.example/auth/start", { method: "POST" }), unconfigured.env, unconfigured.ctx);
	assert.equal(startBlocked.status, 503);
});

test("device verification, browser-cookie binding, replay lock, cancellation, and IP limits protect OAuth", async () => {
	const harness = createTestEnv();

	// Wrong user verification code cannot redirect to GitHub; 5 wrong attempts fail the handshake.
	const startRes = await handleRequest(
		new Request("https://sync.example/auth/start", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.5" } }),
		harness.env,
		harness.ctx,
	);
	const start = (await startRes.json()) as { state: string; pollToken: string; userCode: string; authorizeUrl: string };
	const prompt = await handleRequest(new Request(start.authorizeUrl), harness.env, harness.ctx);
	const csrfCookie = extractCookieValue(prompt, "sda_login_csrf");
	for (let attempt = 1; attempt <= 5; attempt++) {
		const badCode = await handleRequest(
			new Request("https://sync.example/auth/login", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Cookie: `sda_login_csrf=${csrfCookie}`,
				},
				body: new URLSearchParams({ state: start.state, user_code: "WRONG-0000" }).toString(),
			}),
			harness.env,
			harness.ctx,
		);
		assert.equal(badCode.status, 403);
	}
	const failedPoll = await handleRequest(
		new Request("https://sync.example/auth/poll", {
			method: "POST",
			body: JSON.stringify({ state: start.state, pollToken: start.pollToken }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(failedPoll.status, 409);

	// Callback without matching browser cookie is refused even with valid state.
	const verified = await startAndVerifyDevice(harness, "203.0.113.6");
	const stolenCallback = await handleRequest(
		new Request(`https://sync.example/auth/callback?code=any&state=${verified.start.state}`, {
			headers: { Cookie: `sda_auth_bind=${"f".repeat(64)}` },
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(stolenCallback.status, 403);

	// Replaying the callback with the real cookie after consumption does NOT call GitHub again.
	let githubCalls = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		githubCalls++;
		return Response.json({ error: "bad_verification_code", error_description: "<script>alert(1)</script>" });
	}) as typeof fetch;
	try {
		const badExchange = await handleRequest(
			new Request(`https://sync.example/auth/callback?code=bad&state=${verified.start.state}`, {
				headers: { Cookie: `sda_auth_bind=${verified.bindCookie}` },
			}),
			harness.env,
			harness.ctx,
		);
		assert.equal(badExchange.status, 400);
		const html = await badExchange.text();
		assert.doesNotMatch(html, /<script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

		const replay = await handleRequest(
			new Request(`https://sync.example/auth/callback?code=bad&state=${verified.start.state}`, {
				headers: { Cookie: `sda_auth_bind=${verified.bindCookie}` },
			}),
			harness.env,
			harness.ctx,
		);
		assert.equal(replay.status, 410);
		assert.equal(githubCalls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}

	// GitHub user cancellation marks the poll as terminal failure.
	const cancelFlow = await startAndVerifyDevice(harness, "203.0.113.7");
	const canceled = await handleRequest(
		new Request(`https://sync.example/auth/callback?error=access_denied&error_description=User%20canceled&state=${cancelFlow.start.state}`, {
			headers: { Cookie: `sda_auth_bind=${cancelFlow.bindCookie}` },
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(canceled.status, 400);
	const canceledPoll = await handleRequest(
		new Request("https://sync.example/auth/poll", {
			method: "POST",
			body: JSON.stringify({ state: cancelFlow.start.state, pollToken: cancelFlow.start.pollToken }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(canceledPoll.status, 409);

	// Pending starts from one IP are capped at 10.
	for (let i = 0; i < 10; i++) {
		const res = await handleRequest(
			new Request("https://sync.example/auth/start", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.99" } }),
			harness.env,
			harness.ctx,
		);
		assert.equal(res.status, 201);
	}
	const throttled = await handleRequest(
		new Request("https://sync.example/auth/start", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.99" } }),
		harness.env,
		harness.ctx,
	);
	assert.equal(throttled.status, 429);

	// Full sign-in, /api/me, and logout revocation.
	const auth = await signInUser(harness, { id: 42, login: "foxokiso" }, "203.0.113.88");
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

test("settings, watchlist, and saved tickets enforce revisions, caps, UTC sorting, tombstones, and user isolation", async () => {
	const harness = createTestEnv();
	const alice = await signInUser(harness, { id: 1, login: "alice" }, "203.0.113.11");
	const bob = await signInUser(harness, { id: 2, login: "bob" }, "203.0.113.12");
	const asAlice = { Authorization: `Bearer ${alice.token}` };
	const asBob = { Authorization: `Bearer ${bob.token}` };

	// Concurrent initial settings writes: one succeeds with rev 1, the other gets 409 (never 500).
	const [firstA, firstB] = await Promise.all([
		handleRequest(
			new Request("https://sync.example/api/settings", {
				method: "PUT",
				headers: asAlice,
				body: JSON.stringify({ settings: { version: 2, appearance: { theme: "theme-pierce27" } }, expectedRevision: 0 }),
			}),
			harness.env,
			harness.ctx,
		),
		handleRequest(
			new Request("https://sync.example/api/settings", {
				method: "PUT",
				headers: asAlice,
				body: JSON.stringify({ settings: { version: 2, appearance: { theme: "theme-majestic" } }, expectedRevision: 0 }),
			}),
			harness.env,
			harness.ctx,
		),
	]);
	assert.deepEqual([firstA.status, firstB.status].sort(), [200, 409]);

	// Stale revision write returns 409 and does NOT mutate stored settings.
	const staleSettings = await handleRequest(
		new Request("https://sync.example/api/settings", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({ settings: { version: 2, appearance: { theme: "theme-anime" } }, expectedRevision: 0 }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(staleSettings.status, 409);

	const afterStale = await handleRequest(new Request("https://sync.example/api/sync", { headers: asAlice }), harness.env, harness.ctx);
	const afterStaleJson = (await afterStale.json()) as {
		settings: { revision: number; settings: { appearance: { theme: string } } };
	};
	assert.equal(afterStaleJson.settings.revision, 1);
	assert.equal(afterStaleJson.settings.settings.appearance.theme, "theme-pierce27");

	// Oversized settings rejected.
	const oversizedSettings = await handleRequest(
		new Request("https://sync.example/api/settings", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({ settings: { big: "a".repeat(MEMORY_LIMITS.maxSettingsBytes) }, expectedRevision: 1 }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(oversizedSettings.status, 413);

	// Watchlist: UTC timestamp normalization, duplicate/cap checks, and revision conflicts.
	const putWatch = await handleRequest(
		new Request("https://sync.example/api/watchlist", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({
				expectedRevision: 0,
				items: [
					{ symbol: "aapl", addedAt: "2026-11-22T10:00:00Z" },
					{ symbol: "brk.b", notes: "Support level", addedAt: "2026-11-22T11:30:00+02:00" }, // 09:30 UTC -> earlier!
				],
			}),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(putWatch.status, 200);
	const watchConflict = await handleRequest(
		new Request("https://sync.example/api/watchlist", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({ expectedRevision: 0, items: [{ symbol: "NVDA" }] }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(watchConflict.status, 409);

	// Saved tickets: isolated per user, revisioned, tombstone prevents stale PUT resurrection.
	const ticketBody = (symbol: string, expectedRevision: number) =>
		JSON.stringify({ symbol, label: `${symbol} call spread`, broker: "robinhood", order: { symbol, legs: [] }, expectedRevision });
	const aliceTicket = await handleRequest(
		new Request("https://sync.example/api/tickets/spread-1", { method: "PUT", headers: asAlice, body: ticketBody("AAPL", 0) }),
		harness.env,
		harness.ctx,
	);
	const bobTicket = await handleRequest(
		new Request("https://sync.example/api/tickets/spread-1", { method: "PUT", headers: asBob, body: ticketBody("MSFT", 0) }),
		harness.env,
		harness.ctx,
	);
	assert.equal(aliceTicket.status, 201);
	assert.equal(bobTicket.status, 201);

	const aliceSync = await handleRequest(new Request("https://sync.example/api/sync", { headers: asAlice }), harness.env, harness.ctx);
	const syncData = (await aliceSync.json()) as {
		watchlist: { items: Array<{ symbol: string; addedAt: string }>; revision: number };
		savedTickets: Array<{ id: string; symbol: string; revision: number }>;
	};
	assert.deepEqual(syncData.watchlist.items.map((item) => item.symbol), ["BRK.B", "AAPL"]);
	assert.equal(syncData.watchlist.items[0].addedAt, "2026-11-22T09:30:00.000Z");
	assert.deepEqual(syncData.savedTickets.map((item) => [item.id, item.symbol, item.revision]), [["spread-1", "AAPL", 1]]);

	// Delete Alice's ticket, confirm deletion in /api/sync, and ensure stale PUT cannot recreate it.
	const delRes = await handleRequest(
		new Request("https://sync.example/api/tickets/spread-1?expectedRevision=1", { method: "DELETE", headers: asAlice }),
		harness.env,
		harness.ctx,
	);
	assert.equal(delRes.status, 200);

	const afterDelete = await handleRequest(new Request("https://sync.example/api/sync", { headers: asAlice }), harness.env, harness.ctx);
	assert.deepEqual(((await afterDelete.json()) as { savedTickets: unknown[] }).savedTickets, []);

	const resurrect = await handleRequest(
		new Request("https://sync.example/api/tickets/spread-1", { method: "PUT", headers: asAlice, body: ticketBody("AAPL", 0) }),
		harness.env,
		harness.ctx,
	);
	assert.equal(resurrect.status, 409);

	const badId = await handleRequest(
		new Request("https://sync.example/api/tickets/%E0%A4%A", { method: "DELETE", headers: asAlice }),
		harness.env,
		harness.ctx,
	);
	assert.equal(badId.status, 400);

	// Ticket cap: 100 active saved tickets are allowed, 101st is rejected with 413.
	const duplicateWatch = await handleRequest(
		new Request("https://sync.example/api/watchlist", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({ expectedRevision: 1, items: [{ symbol: "aapl" }, { symbol: "AAPL" }] }),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(duplicateWatch.status, 400);

	const tooManyWatch = await handleRequest(
		new Request("https://sync.example/api/watchlist", {
			method: "PUT",
			headers: asAlice,
			body: JSON.stringify({
				expectedRevision: 1,
				items: Array.from({ length: MEMORY_LIMITS.maxWatchlistItems + 1 }, (_, i) => ({ symbol: `SYM${i}` })),
			}),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(tooManyWatch.status, 413);

	for (let i = 0; i < MEMORY_LIMITS.maxSavedTickets; i++) {
		const res = await handleRequest(
			new Request(`https://sync.example/api/tickets/cap-${i}`, {
				method: "PUT",
				headers: asAlice,
				body: ticketBody("AAPL", 0),
			}),
			harness.env,
			harness.ctx,
		);
		assert.equal(res.status, 201);
	}
	const overCap = await handleRequest(
		new Request("https://sync.example/api/tickets/cap-over", {
			method: "PUT",
			headers: asAlice,
			body: ticketBody("AAPL", 0),
		}),
		harness.env,
		harness.ctx,
	);
	assert.equal(overCap.status, 413);

	// Bob's ticket with the same ID must still be intact.
	const bobSync = await handleRequest(new Request("https://sync.example/api/sync", { headers: asBob }), harness.env, harness.ctx);
	assert.equal(((await bobSync.json()) as { savedTickets: unknown[] }).savedTickets.length, 1);

	await harness.flush();
});

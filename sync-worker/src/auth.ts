import { randomHex, sha256Hex, timingSafeEqualStrings } from "./crypto.ts";
import { renderHtmlPage } from "./html.ts";
import { HttpError, isRecord, jsonError, jsonOk, readBoundedJson } from "./limits.ts";

const AUTH_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HEX_64 = /^[a-f0-9]{64}$/;

export interface AuthenticatedUser {
	id: string;
	githubId: number;
	githubLogin: string;
	avatarUrl: string | null;
}

export interface AuthContext {
	user: AuthenticatedUser;
	tokenHash: string;
}

interface UserRow {
	id: string;
	github_id: number;
	github_login: string;
	avatar_url: string | null;
}

interface AuthRequestRow {
	state: string;
	poll_hash: string;
	status: "pending" | "ready";
	user_id: string | null;
	expires_at: string;
}

function toUser(row: UserRow): AuthenticatedUser {
	return {
		id: row.id,
		githubId: row.github_id,
		githubLogin: row.github_login,
		avatarUrl: row.avatar_url,
	};
}

type RuntimeOAuthEnv = Env & {
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
};

function readOAuthCredentials(env: Env): { clientId: string; clientSecret: string } | null {
	const runtimeEnv = env as RuntimeOAuthEnv;
	const clientId = runtimeEnv.GITHUB_CLIENT_ID?.trim() ?? "";
	const clientSecret = runtimeEnv.GITHUB_CLIENT_SECRET?.trim() ?? "";
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function isOAuthConfigured(env: Env): boolean {
	return readOAuthCredentials(env) !== null;
}

/** Validates an incoming Bearer token against D1 sessions and returns the signed-in user. */
export async function requireAuth(request: Request, env: Env, ctx: ExecutionContext): Promise<AuthContext | null> {
	const header = request.headers.get("Authorization");
	if (!header) return null;
	const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(header.trim());
	if (!match) return null;

	const tokenHash = await sha256Hex(match[1].toLowerCase());
	const now = new Date().toISOString();
	const row = await env.DB.prepare(
		`SELECT users.id, users.github_id, users.github_login, users.avatar_url
		 FROM sessions
		 JOIN users ON users.id = sessions.user_id
		 WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
	)
		.bind(tokenHash, now)
		.first<UserRow>();

	if (!row) return null;

	ctx.waitUntil(
		env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
			.bind(now, tokenHash)
			.run()
			.catch(() => {}),
	);

	return { user: toUser(row), tokenHash };
}

/** Starts a desktop OAuth handshake, returning a state + single-use poll token. */
export async function handleAuthStart(request: Request, env: Env): Promise<Response> {
	if (!isOAuthConfigured(env)) {
		return jsonError(503, "GitHub OAuth is not configured on this Worker yet.");
	}

	const nowMs = Date.now();
	const now = new Date(nowMs).toISOString();
	const expiresAt = new Date(nowMs + AUTH_TTL_MS).toISOString();
	const state = randomHex(32);
	const pollToken = randomHex(32);
	const pollHash = await sha256Hex(pollToken);

	await env.DB.batch([
		env.DB.prepare("DELETE FROM auth_requests WHERE expires_at <= ?").bind(now),
		env.DB.prepare(
			"INSERT INTO auth_requests (state, poll_hash, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)",
		).bind(state, pollHash, now, expiresAt),
	]);

	const origin = new URL(request.url).origin;
	return jsonOk(
		{
			state,
			pollToken,
			authorizeUrl: `${origin}/auth/login?state=${state}`,
			callbackUrl: `${origin}/auth/callback`,
			expiresAt,
		},
		201,
	);
}

/** Redirects the user's browser to GitHub OAuth authorize for a pending state. */
export async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
	const oauth = readOAuthCredentials(env);
	if (!oauth) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · OAuth not configured`,
			heading: "GitHub sign-in is not configured yet",
			message: "Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to this Worker before signing in.",
			ok: false,
			status: 503,
		});
	}

	const url = new URL(request.url);
	const state = url.searchParams.get("state") ?? "";
	if (!HEX_64.test(state)) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Invalid sign-in link`,
			heading: "Invalid sign-in request",
			message: "Start sign-in again from Dip Analyzer PRO.",
			ok: false,
			status: 400,
		});
	}

	const now = new Date().toISOString();
	const pending = await env.DB.prepare(
		"SELECT state FROM auth_requests WHERE state = ? AND status = 'pending' AND expires_at > ?",
	)
		.bind(state, now)
		.first<{ state: string }>();

	if (!pending) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Link expired`,
			heading: "Sign-in request expired",
			message: "This sign-in link has expired or was already used. Start sign-in again from the app.",
			ok: false,
			status: 410,
		});
	}

	const githubAuth = new URL("https://github.com/login/oauth/authorize");
	githubAuth.searchParams.set("client_id", oauth.clientId);
	githubAuth.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
	githubAuth.searchParams.set("state", state);
	githubAuth.searchParams.set("scope", "read:user");
	return Response.redirect(githubAuth.toString(), 302);
}

interface GitHubTokenResponse {
	access_token?: unknown;
	error?: unknown;
	error_description?: unknown;
}

interface GitHubUserResponse {
	id?: unknown;
	login?: unknown;
	avatar_url?: unknown;
}

/** Handles GitHub's OAuth callback, creates/updates the user, and marks the poll ready. */
export async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
	const oauth = readOAuthCredentials(env);
	if (!oauth) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · OAuth not configured`,
			heading: "GitHub sign-in is not configured yet",
			message: "Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to this Worker first.",
			ok: false,
			status: 503,
		});
	}

	const url = new URL(request.url);
	const oauthError = url.searchParams.get("error");
	if (oauthError) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Sign-in canceled`,
			heading: "GitHub sign-in was canceled",
			message: url.searchParams.get("error_description") ?? "Authorization did not complete.",
			ok: false,
			status: 400,
		});
	}

	const code = url.searchParams.get("code") ?? "";
	const state = url.searchParams.get("state") ?? "";
	if (!code || !HEX_64.test(state)) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Invalid callback`,
			heading: "Missing authorization details",
			message: "GitHub did not include a valid code and state. Start sign-in again from the app.",
			ok: false,
			status: 400,
		});
	}

	const now = new Date().toISOString();
	const pending = await env.DB.prepare(
		"SELECT state FROM auth_requests WHERE state = ? AND status = 'pending' AND expires_at > ?",
	)
		.bind(state, now)
		.first<{ state: string }>();

	if (!pending) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Expired`,
			heading: "Sign-in request expired",
			message: "This sign-in session expired or was already completed. Start again from the app.",
			ok: false,
			status: 410,
		});
	}

	const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": "stock-dip-analyzer-sync",
		},
		body: JSON.stringify({
			client_id: oauth.clientId,
			client_secret: oauth.clientSecret,
			code,
			redirect_uri: `${url.origin}/auth/callback`,
		}),
	});
	if (!tokenResponse.ok) {
		throw new Error(`GitHub token exchange failed with HTTP ${tokenResponse.status}`);
	}

	const tokenData = (await tokenResponse.json()) as GitHubTokenResponse;
	if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Sign-in failed`,
			heading: "GitHub declined the code",
			message: typeof tokenData.error_description === "string" ? tokenData.error_description : "Could not obtain a GitHub access token.",
			ok: false,
			status: 400,
		});
	}

	const userResponse = await fetch("https://api.github.com/user", {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${tokenData.access_token}`,
			"User-Agent": "stock-dip-analyzer-sync",
		},
	});
	if (!userResponse.ok) {
		throw new Error(`GitHub user fetch failed with HTTP ${userResponse.status}`);
	}

	const ghUser = (await userResponse.json()) as GitHubUserResponse;
	if (typeof ghUser.id !== "number" || !Number.isInteger(ghUser.id) || typeof ghUser.login !== "string" || !ghUser.login) {
		throw new Error("GitHub user response lacked id or login");
	}

	const avatarUrl = typeof ghUser.avatar_url === "string" ? ghUser.avatar_url : null;
	const newUserId = crypto.randomUUID();
	const upserted = await env.DB.prepare(
		`INSERT INTO users (id, github_id, github_login, avatar_url, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(github_id) DO UPDATE SET
		   github_login = excluded.github_login,
		   avatar_url = excluded.avatar_url,
		   updated_at = excluded.updated_at
		 RETURNING id`,
	)
		.bind(newUserId, ghUser.id, ghUser.login, avatarUrl, now, now)
		.first<{ id: string }>();

	if (!upserted) throw new Error("Failed to store signed-in user");

	const updated = await env.DB.prepare(
		"UPDATE auth_requests SET status = 'ready', user_id = ? WHERE state = ? AND status = 'pending' AND expires_at > ?",
	)
		.bind(upserted.id, state, now)
		.run();

	if ((updated.meta?.changes ?? 0) === 0) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Expired`,
			heading: "Sign-in request expired",
			message: "Start sign-in again from Dip Analyzer PRO.",
			ok: false,
			status: 410,
		});
	}

	return renderHtmlPage({
		title: `${env.APP_NAME} · Signed in`,
		heading: `Signed in as @${ghUser.login}`,
		message: "You can close this tab and return to Dip Analyzer PRO.",
		ok: true,
	});
}

/** Exchanges a completed OAuth handshake for a bearer session token exactly once. */
export async function handleAuthPoll(request: Request, env: Env): Promise<Response> {
	const body = await readBoundedJson(request);
	if (!isRecord(body) || typeof body.state !== "string" || typeof body.pollToken !== "string") {
		throw new HttpError(400, "state and pollToken are required.");
	}
	const state = body.state.toLowerCase();
	const pollToken = body.pollToken.toLowerCase();
	if (!HEX_64.test(state) || !HEX_64.test(pollToken)) {
		throw new HttpError(400, "state and pollToken must be 64-character hex strings.");
	}

	const row = await env.DB.prepare(
		"SELECT state, poll_hash, status, user_id, expires_at FROM auth_requests WHERE state = ?",
	)
		.bind(state)
		.first<AuthRequestRow>();

	if (!row) return jsonError(404, "Sign-in request not found.");
	const nowMs = Date.now();
	const now = new Date(nowMs).toISOString();
	if (row.expires_at <= now) {
		await env.DB.prepare("DELETE FROM auth_requests WHERE state = ?").bind(state).run();
		return jsonError(410, "Sign-in request expired.");
	}

	const providedHash = await sha256Hex(pollToken);
	const hashMatches = await timingSafeEqualStrings(providedHash, row.poll_hash);
	if (!hashMatches) return jsonError(403, "Invalid poll token.");
	if (row.status === "pending") return jsonOk({ status: "pending" }, 202);

	const claimed = await env.DB.prepare(
		"DELETE FROM auth_requests WHERE state = ? AND status = 'ready' AND expires_at > ? RETURNING user_id",
	)
		.bind(state, now)
		.first<{ user_id: string | null }>();

	if (!claimed?.user_id) return jsonError(410, "Sign-in token was already claimed.");

	const sessionToken = randomHex(32);
	const tokenHash = await sha256Hex(sessionToken);
	const expiresAt = new Date(nowMs + SESSION_TTL_MS).toISOString();

	await env.DB.prepare(
		"INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(tokenHash, claimed.user_id, now, expiresAt, now)
		.run();

	const user = await env.DB.prepare("SELECT id, github_id, github_login, avatar_url FROM users WHERE id = ?")
		.bind(claimed.user_id)
		.first<UserRow>();

	if (!user) return jsonError(404, "User record not found.");
	return jsonOk({ status: "authenticated", token: sessionToken, expiresAt, user: toUser(user) });
}

export async function handleAuthLogout(auth: AuthContext, env: Env): Promise<Response> {
	await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(auth.tokenHash).run();
	return jsonOk({ ok: true });
}

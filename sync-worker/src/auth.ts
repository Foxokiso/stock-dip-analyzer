import { randomHex, sha256Hex, timingSafeEqualStrings } from "./crypto.ts";
import { renderHtmlPage, renderLoginPrompt } from "./html.ts";
import { HttpError, isRecord, jsonError, jsonOk, readBoundedJson, readBoundedText } from "./limits.ts";

const AUTH_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GITHUB_TIMEOUT_MS = 10_000;
const MAX_PENDING_PER_IP = 10;
const MAX_PENDING_GLOBAL = 500;
const MAX_CODE_ATTEMPTS = 5;
const HEX_64 = /^[a-f0-9]{64}$/;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BIND_COOKIE_NAME = "sda_auth_bind";
const CSRF_COOKIE_NAME = "sda_login_csrf";

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
	user_code_hash: string;
	browser_hash: string | null;
	status: "pending" | "authorized" | "exchanging" | "ready" | "failed";
	attempts: number;
	user_id: string | null;
	error_message: string | null;
	expires_at: string;
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

function toUser(row: UserRow): AuthenticatedUser {
	return {
		id: row.id,
		githubId: row.github_id,
		githubLogin: row.github_login,
		avatarUrl: row.avatar_url,
	};
}

function generateUserCode(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	const chars = Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
	return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function normalizeUserCode(raw: string): string {
	return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get("Cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx <= 0) continue;
		if (part.slice(0, idx).trim() === name) {
			return part.slice(idx + 1).trim();
		}
	}
	return null;
}

function authCookieHeader(name: string, value: string, url: URL, maxAgeSeconds: number): string {
	const secure = url.protocol === "https:" ? "; Secure" : "";
	return `${name}=${value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function appendCookies(response: Response, cookies: string[]): Response {
	const headers = new Headers(response.headers);
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(response.body, { status: response.status, headers });
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

/** Starts a desktop OAuth handshake, returning state, single-use poll token, and user verification code. */
export async function handleAuthStart(request: Request, env: Env): Promise<Response> {
	if (!isOAuthConfigured(env)) {
		return jsonError(503, "GitHub OAuth is not configured on this Worker yet.");
	}

	const nowMs = Date.now();
	const now = new Date(nowMs).toISOString();
	const expiresAt = new Date(nowMs + AUTH_TTL_MS).toISOString();
	const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const ipHash = await sha256Hex(clientIp);

	// Prune expired auth handshakes and expired sessions before checking pending caps.
	await env.DB.batch([
		env.DB.prepare("DELETE FROM auth_requests WHERE expires_at <= ?").bind(now),
		env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
	]);

	const [ipCounts, globalCounts] = await Promise.all([
		env.DB.prepare("SELECT COUNT(*) AS count FROM auth_requests WHERE ip_hash = ? AND expires_at > ?")
			.bind(ipHash, now)
			.first<{ count: number }>(),
		env.DB.prepare("SELECT COUNT(*) AS count FROM auth_requests WHERE expires_at > ?")
			.bind(now)
			.first<{ count: number }>(),
	]);

	if ((ipCounts?.count ?? 0) >= MAX_PENDING_PER_IP || (globalCounts?.count ?? 0) >= MAX_PENDING_GLOBAL) {
		return jsonError(429, "Too many pending sign-in requests. Try again in a few minutes.");
	}

	const state = randomHex(32);
	const pollToken = randomHex(32);
	const userCode = generateUserCode();
	const [pollHash, userCodeHash] = await Promise.all([
		sha256Hex(pollToken),
		sha256Hex(normalizeUserCode(userCode)),
	]);

	await env.DB.prepare(
		"INSERT INTO auth_requests (state, poll_hash, user_code_hash, ip_hash, status, attempts, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
	)
		.bind(state, pollHash, userCodeHash, ipHash, now, expiresAt)
		.run();

	const origin = new URL(request.url).origin;
	return jsonOk(
		{
			state,
			pollToken,
			userCode,
			authorizeUrl: `${origin}/auth/login?state=${state}`,
			callbackUrl: `${origin}/auth/callback`,
			expiresAt,
		},
		201,
	);
}

/** Shows the device verification-code confirmation form before redirecting to GitHub. */
export async function handleAuthLoginPage(request: Request, env: Env): Promise<Response> {
	if (!isOAuthConfigured(env)) {
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

	const csrfNonce = randomHex(32);
	return renderLoginPrompt({
		title: `${env.APP_NAME} · Confirm sign-in`,
		state,
		setCookie: authCookieHeader(CSRF_COOKIE_NAME, csrfNonce, url, 600),
	});
}

/** Validates the user verification code, binds the browser via HttpOnly cookie, and redirects to GitHub. */
export async function handleAuthLoginSubmit(request: Request, env: Env): Promise<Response> {
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
	const csrfCookie = readCookie(request, CSRF_COOKIE_NAME);
	if (!csrfCookie || !HEX_64.test(csrfCookie)) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Missing browser cookie`,
			heading: "Browser cookies required",
			message: "Reload the sign-in link from Dip Analyzer PRO and ensure cookies are enabled.",
			ok: false,
			status: 403,
		});
	}

	const rawText = await readBoundedText(request, 4096);
	const form = new URLSearchParams(rawText);
	const state = (form.get("state") ?? "").toLowerCase();
	const submittedCode = normalizeUserCode(form.get("user_code") ?? "");
	if (!HEX_64.test(state)) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Invalid sign-in`,
			heading: "Invalid sign-in request",
			message: "Start sign-in again from Dip Analyzer PRO.",
			ok: false,
			status: 400,
		});
	}

	const now = new Date().toISOString();
	const row = await env.DB.prepare(
		"SELECT state, user_code_hash, status, attempts, expires_at FROM auth_requests WHERE state = ?",
	)
		.bind(state)
		.first<Pick<AuthRequestRow, "state" | "user_code_hash" | "status" | "attempts" | "expires_at">>();

	if (!row || row.expires_at <= now || row.status !== "pending") {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Link expired`,
			heading: "Sign-in request expired",
			message: "This sign-in link has expired or was already used. Start sign-in again from the app.",
			ok: false,
			status: 410,
		});
	}

	const submittedHash = await sha256Hex(submittedCode);
	const codeMatches = submittedCode.length === 8 && (await timingSafeEqualStrings(submittedHash, row.user_code_hash));
	if (!codeMatches) {
		const nextAttempts = row.attempts + 1;
		if (nextAttempts >= MAX_CODE_ATTEMPTS) {
			await env.DB.prepare(
				"UPDATE auth_requests SET status = 'failed', attempts = ?, error_message = ? WHERE state = ? AND status = 'pending'",
			)
				.bind(nextAttempts, "Too many incorrect verification code attempts.", state)
				.run();
			return renderHtmlPage({
				title: `${env.APP_NAME} · Verification failed`,
				heading: "Too many incorrect codes",
				message: "Start sign-in again from Dip Analyzer PRO to get a new code.",
				ok: false,
				status: 403,
			});
		}
		await env.DB.prepare("UPDATE auth_requests SET attempts = ? WHERE state = ? AND status = 'pending'")
			.bind(nextAttempts, state)
			.run();
		return renderLoginPrompt({
			title: `${env.APP_NAME} · Confirm sign-in`,
			state,
			error: `That code does not match Dip Analyzer PRO (${MAX_CODE_ATTEMPTS - nextAttempts} attempts left).`,
			status: 403,
		});
	}

	const browserNonce = randomHex(32);
	const browserHash = await sha256Hex(browserNonce);
	const updated = await env.DB.prepare(
		"UPDATE auth_requests SET status = 'authorized', browser_hash = ? WHERE state = ? AND status = 'pending' AND expires_at > ?",
	)
		.bind(browserHash, state, now)
		.run();

	if ((updated.meta?.changes ?? 0) === 0) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Link expired`,
			heading: "Sign-in request expired",
			message: "Start sign-in again from Dip Analyzer PRO.",
			ok: false,
			status: 410,
		});
	}

	const githubAuth = new URL("https://github.com/login/oauth/authorize");
	githubAuth.searchParams.set("client_id", oauth.clientId);
	githubAuth.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
	githubAuth.searchParams.set("state", state);
	githubAuth.searchParams.set("scope", "read:user");

	const redirectResponse = new Response(null, {
		status: 302,
		headers: {
			Location: githubAuth.toString(),
			"Cache-Control": "no-store",
		},
	});
	return appendCookies(redirectResponse, [
		authCookieHeader(CSRF_COOKIE_NAME, "", url, 0),
		authCookieHeader(BIND_COOKIE_NAME, browserNonce, url, 600),
	]);
}

interface GitHubTokenResponse {
	access_token?: unknown;
	error_description?: unknown;
}

interface GitHubUserResponse {
	id?: unknown;
	login?: unknown;
	avatar_url?: unknown;
}

/** Handles GitHub's OAuth callback, verifies the browser-binding cookie, and completes sign-in. */
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
	const clearBindCookie = authCookieHeader(BIND_COOKIE_NAME, "", url, 0);
	const state = (url.searchParams.get("state") ?? "").toLowerCase();
	const browserNonce = readCookie(request, BIND_COOKIE_NAME);

	if (!HEX_64.test(state) || !browserNonce || !HEX_64.test(browserNonce)) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Sign-in blocked`,
			heading: "Could not verify browser session",
			message: "Open the sign-in link in the same browser where you confirmed the verification code.",
			ok: false,
			status: 403,
			setCookie: clearBindCookie,
		});
	}

	const now = new Date().toISOString();
	const oauthError = url.searchParams.get("error");
	const browserHash = await sha256Hex(browserNonce);

	if (oauthError) {
		const description = url.searchParams.get("error_description") ?? "Authorization was canceled on GitHub.";
		const row = await env.DB.prepare(
			"SELECT browser_hash FROM auth_requests WHERE state = ? AND status = 'authorized' AND expires_at > ?",
		)
			.bind(state, now)
			.first<{ browser_hash: string | null }>();
		if (row?.browser_hash && (await timingSafeEqualStrings(browserHash, row.browser_hash))) {
			await env.DB.prepare(
				"UPDATE auth_requests SET status = 'failed', error_message = ? WHERE state = ? AND status = 'authorized'",
			)
				.bind(description.slice(0, 200), state)
				.run();
		}
		return renderHtmlPage({
			title: `${env.APP_NAME} · Sign-in canceled`,
			heading: "GitHub sign-in was canceled",
			message: description,
			ok: false,
			status: 400,
			setCookie: clearBindCookie,
		});
	}

	const code = url.searchParams.get("code") ?? "";
	if (!code) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Invalid callback`,
			heading: "Missing authorization details",
			message: "GitHub did not include an authorization code. Start sign-in again from the app.",
			ok: false,
			status: 400,
			setCookie: clearBindCookie,
		});
	}

	const precheck = await env.DB.prepare(
		"SELECT status, browser_hash, expires_at FROM auth_requests WHERE state = ?",
	)
		.bind(state)
		.first<{ status: string; browser_hash: string | null; expires_at: string }>();

	if (!precheck || precheck.expires_at <= now || precheck.status !== "authorized") {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Expired`,
			heading: "Sign-in request expired",
			message: "This sign-in session expired or was already completed. Start again from the app.",
			ok: false,
			status: 410,
			setCookie: clearBindCookie,
		});
	}

	if (!precheck.browser_hash || !(await timingSafeEqualStrings(browserHash, precheck.browser_hash))) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Sign-in blocked`,
			heading: "Browser session mismatch",
			message: "Complete GitHub sign-in in the same browser where you confirmed the verification code.",
			ok: false,
			status: 403,
		});
	}

	// Atomically consume the 'authorized' state before contacting GitHub so callbacks cannot be replayed.
	const consumed = await env.DB.prepare(
		"UPDATE auth_requests SET status = 'exchanging' WHERE state = ? AND status = 'authorized' AND browser_hash = ? AND expires_at > ?",
	)
		.bind(state, precheck.browser_hash, now)
		.run();

	if ((consumed.meta?.changes ?? 0) === 0) {
		return renderHtmlPage({
			title: `${env.APP_NAME} · Expired`,
			heading: "Sign-in request expired",
			message: "This sign-in session expired or was already completed. Start again from the app.",
			ok: false,
			status: 410,
			setCookie: clearBindCookie,
		});
	}

	const failHandshake = async (message: string, status: number, heading: string) => {
		await env.DB.prepare(
			"UPDATE auth_requests SET status = 'failed', error_message = ? WHERE state = ? AND status = 'exchanging'",
		)
			.bind(message, state)
			.run();
		return renderHtmlPage({
			title: `${env.APP_NAME} · Sign-in failed`,
			heading,
			message,
			ok: false,
			status,
			setCookie: clearBindCookie,
		});
	};

	let tokenResponse: Response;
	try {
		tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
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
	} catch {
		return failHandshake("Could not reach GitHub in time. Start sign-in again from the app.", 502, "GitHub did not answer");
	}
	if (!tokenResponse.ok) {
		return failHandshake(`GitHub token exchange returned HTTP ${tokenResponse.status}. Start sign-in again.`, 502, "GitHub sign-in error");
	}

	const tokenData = (await tokenResponse.json()) as GitHubTokenResponse;
	if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
		const message = typeof tokenData.error_description === "string"
			? tokenData.error_description
			: "Could not obtain a GitHub access token.";
		return failHandshake(message, 400, "GitHub declined the code");
	}

	let userResponse: Response;
	try {
		userResponse = await fetch("https://api.github.com/user", {
			signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${tokenData.access_token}`,
				"User-Agent": "stock-dip-analyzer-sync",
			},
		});
	} catch {
		return failHandshake("Could not reach GitHub user profile in time. Start sign-in again.", 502, "GitHub did not answer");
	}
	if (!userResponse.ok) {
		return failHandshake(`GitHub user lookup returned HTTP ${userResponse.status}. Start sign-in again.`, 502, "GitHub profile error");
	}

	const ghUser = (await userResponse.json()) as GitHubUserResponse;
	if (typeof ghUser.id !== "number" || !Number.isInteger(ghUser.id) || typeof ghUser.login !== "string" || !ghUser.login) {
		return failHandshake("GitHub user response lacked id or login.", 502, "Invalid GitHub profile");
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
		"UPDATE auth_requests SET status = 'ready', user_id = ? WHERE state = ? AND status = 'exchanging' AND expires_at > ?",
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
			setCookie: clearBindCookie,
		});
	}

	return renderHtmlPage({
		title: `${env.APP_NAME} · Signed in`,
		heading: `Signed in as @${ghUser.login}`,
		message: "You can close this tab and return to Dip Analyzer PRO.",
		ok: true,
		setCookie: clearBindCookie,
	});
}

/** Exchanges a completed OAuth handshake for a bearer session token in one atomic DB batch. */
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
		"SELECT state, poll_hash, status, user_id, error_message, expires_at FROM auth_requests WHERE state = ?",
	)
		.bind(state)
		.first<Pick<AuthRequestRow, "state" | "poll_hash" | "status" | "user_id" | "error_message" | "expires_at">>();

	if (!row) return jsonError(404, "Sign-in request not found.");
	const nowMs = Date.now();
	const now = new Date(nowMs).toISOString();
	if (row.expires_at <= now) {
		await env.DB.prepare("DELETE FROM auth_requests WHERE state = ?").bind(state).run();
		return jsonError(410, "Sign-in request expired.");
	}

	const providedHash = await sha256Hex(pollToken);
	if (!(await timingSafeEqualStrings(providedHash, row.poll_hash))) {
		return jsonError(403, "Invalid poll token.");
	}

	if (row.status === "failed") {
		await env.DB.prepare("DELETE FROM auth_requests WHERE state = ? AND status = 'failed'").bind(state).run();
		return jsonOk({ status: "failed", error: row.error_message ?? "Sign-in failed." }, 409);
	}

	if (row.status !== "ready" || !row.user_id) {
		return jsonOk({ status: "pending" }, 202);
	}

	const sessionToken = randomHex(32);
	const tokenHash = await sha256Hex(sessionToken);
	const expiresAt = new Date(nowMs + SESSION_TTL_MS).toISOString();

	// Atomic claim: session creation and handshake deletion commit or roll back together.
	const batchResults = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
			 SELECT ?, user_id, ?, ?, ? FROM auth_requests
			 WHERE state = ? AND status = 'ready' AND expires_at > ?`,
		).bind(tokenHash, now, expiresAt, now, state, now),
		env.DB.prepare("DELETE FROM auth_requests WHERE state = ? AND status = 'ready'").bind(state),
		env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
	]);

	if ((batchResults[0]?.meta?.changes ?? 0) === 0) {
		return jsonError(410, "Sign-in token was already claimed or expired.");
	}

	const user = await env.DB.prepare("SELECT id, github_id, github_login, avatar_url FROM users WHERE id = ?")
		.bind(row.user_id)
		.first<UserRow>();

	if (!user) return jsonError(404, "User record not found.");
	return jsonOk({ status: "authenticated", token: sessionToken, expiresAt, user: toUser(user) });
}

export async function handleAuthLogout(auth: AuthContext, env: Env): Promise<Response> {
	await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(auth.tokenHash).run();
	return jsonOk({ ok: true });
}

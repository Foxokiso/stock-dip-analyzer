import {
	handleAuthCallback,
	handleAuthLogin,
	handleAuthLogout,
	handleAuthPoll,
	handleAuthStart,
	isOAuthConfigured,
	requireAuth,
} from "./auth.ts";
import { renderHtmlPage } from "./html.ts";
import { HttpError, MEMORY_LIMITS, jsonError, jsonOk } from "./limits.ts";
import { handleDeleteTicket, handleGetMe, handleGetSync, handlePutSettings, handlePutWatchlist, handleUpsertTicket } from "./sync.ts";

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const { pathname } = url;
	const method = request.method.toUpperCase();

	if (method === "GET" && pathname === "/") {
		const oauthConfigured = isOAuthConfigured(env);
		return renderHtmlPage({
			title: `${env.APP_NAME} · Cloud Sync`,
			heading: `${env.APP_NAME} Cloud Sync`,
			message: oauthConfigured
				? `GitHub sign-in is configured. OAuth callback URL: ${url.origin}/auth/callback`
				: `D1 sync service is deployed and awaiting GitHub OAuth secrets. Callback URL for your GitHub OAuth App: ${url.origin}/auth/callback`,
			ok: true,
		});
	}

	if (method === "GET" && pathname === "/health") {
		let dbOk = false;
		try {
			const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
			dbOk = row?.ok === 1;
		} catch {
			dbOk = false;
		}
		return jsonOk(
			{
				ok: dbOk,
				service: "stock-dip-analyzer-sync",
				db: dbOk,
				oauthConfigured: isOAuthConfigured(env),
				callbackUrl: `${url.origin}/auth/callback`,
				limits: MEMORY_LIMITS,
			},
			dbOk ? 200 : 503,
		);
	}

	if (method === "POST" && pathname === "/auth/start") return handleAuthStart(request, env);
	if (method === "GET" && pathname === "/auth/login") return handleAuthLogin(request, env);
	if (method === "GET" && pathname === "/auth/callback") return handleAuthCallback(request, env);
	if (method === "POST" && pathname === "/auth/poll") return handleAuthPoll(request, env);

	if (pathname === "/auth/logout" || pathname.startsWith("/api/")) {
		const auth = await requireAuth(request, env, ctx);
		if (!auth) return jsonError(401, "Authentication required.");

		if (method === "POST" && pathname === "/auth/logout") return handleAuthLogout(auth, env);
		if (method === "GET" && pathname === "/api/me") return handleGetMe(auth, env);
		if (method === "GET" && pathname === "/api/sync") return handleGetSync(auth, env);
		if (method === "PUT" && pathname === "/api/settings") return handlePutSettings(request, auth, env);
		if (method === "PUT" && pathname === "/api/watchlist") return handlePutWatchlist(request, auth, env);

		if (pathname.startsWith("/api/tickets/")) {
			let ticketId: string;
			try {
				ticketId = decodeURIComponent(pathname.slice("/api/tickets/".length));
			} catch {
				return jsonError(400, "Invalid ticket id.");
			}
			if (method === "PUT") return handleUpsertTicket(ticketId, request, auth, env);
			if (method === "DELETE") return handleDeleteTicket(ticketId, auth, env);
		}
		return jsonError(404, "Endpoint not found.");
	}

	return jsonError(404, "Endpoint not found.");
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	try {
		const response = await route(request, env, ctx);
		console.log(
			JSON.stringify({
				message: "request",
				method: request.method,
				path: url.pathname,
				status: response.status,
			}),
		);
		return response;
	} catch (error) {
		if (error instanceof HttpError) {
			return jsonError(error.status, error.message);
		}
		console.error(
			JSON.stringify({
				message: "unhandled error",
				method: request.method,
				path: url.pathname,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return jsonError(500, "Internal server error.");
	}
}

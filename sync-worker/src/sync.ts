import type { AuthContext } from "./auth.ts";
import {
	HttpError,
	MEMORY_LIMITS,
	isRecord,
	isValidBroker,
	isValidSymbol,
	isValidTicketId,
	jsonOk,
	readBoundedJson,
	utf8ByteLength,
} from "./limits.ts";

interface SettingsRow {
	payload: string;
	revision: number;
	updated_at: string;
}

interface WatchlistRow {
	symbol: string;
	notes: string | null;
	added_at: string;
}

interface TicketRow {
	id: string;
	symbol: string;
	label: string;
	broker: string;
	payload: string;
	created_at: string;
	updated_at: string;
}

async function getUsage(db: D1Database, userId: string) {
	const [settingsRow, watchlistRow, ticketsRow] = await Promise.all([
		db.prepare("SELECT payload FROM user_settings WHERE user_id = ?").bind(userId).first<{ payload: string }>(),
		db.prepare("SELECT COUNT(*) AS count FROM watchlists WHERE user_id = ?").bind(userId).first<{ count: number }>(),
		db.prepare("SELECT COUNT(*) AS count FROM saved_tickets WHERE user_id = ?").bind(userId).first<{ count: number }>(),
	]);
	return {
		settingsBytes: settingsRow ? utf8ByteLength(settingsRow.payload) : 0,
		watchlistCount: watchlistRow?.count ?? 0,
		savedTicketsCount: ticketsRow?.count ?? 0,
	};
}

export async function handleGetMe(auth: AuthContext, env: Env): Promise<Response> {
	const usage = await getUsage(env.DB, auth.user.id);
	return jsonOk({ user: auth.user, limits: MEMORY_LIMITS, usage });
}

export async function handleGetSync(auth: AuthContext, env: Env): Promise<Response> {
	const [settingsRow, watchlistResult, ticketResult] = await Promise.all([
		env.DB.prepare("SELECT payload, revision, updated_at FROM user_settings WHERE user_id = ?")
			.bind(auth.user.id)
			.first<SettingsRow>(),
		env.DB.prepare("SELECT symbol, notes, added_at FROM watchlists WHERE user_id = ? ORDER BY added_at ASC, symbol ASC")
			.bind(auth.user.id)
			.all<WatchlistRow>(),
		env.DB.prepare(
			"SELECT id, symbol, label, broker, payload, created_at, updated_at FROM saved_tickets WHERE user_id = ? ORDER BY updated_at DESC",
		)
			.bind(auth.user.id)
			.all<TicketRow>(),
	]);

	const watchlist = (watchlistResult.results ?? []).map((row) => ({
		symbol: row.symbol,
		notes: row.notes ?? "",
		addedAt: row.added_at,
	}));

	const savedTickets = (ticketResult.results ?? []).map((row) => ({
		id: row.id,
		symbol: row.symbol,
		label: row.label,
		broker: row.broker,
		order: JSON.parse(row.payload) as unknown,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}));

	return jsonOk({
		user: auth.user,
		settings: settingsRow
			? {
				settings: JSON.parse(settingsRow.payload) as unknown,
				revision: settingsRow.revision,
				updatedAt: settingsRow.updated_at,
			}
			: null,
		watchlist,
		savedTickets,
		limits: MEMORY_LIMITS,
		usage: {
			settingsBytes: settingsRow ? utf8ByteLength(settingsRow.payload) : 0,
			watchlistCount: watchlist.length,
			savedTicketsCount: savedTickets.length,
		},
	});
}

export async function handlePutSettings(request: Request, auth: AuthContext, env: Env): Promise<Response> {
	const body = await readBoundedJson(request);
	if (!isRecord(body) || !isRecord(body.settings)) {
		throw new HttpError(400, "Body must contain a settings JSON object.");
	}
	if (body.expectedRevision !== undefined && (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)) {
		throw new HttpError(400, "expectedRevision must be a non-negative integer.");
	}

	const payload = JSON.stringify(body.settings);
	const bytes = utf8ByteLength(payload);
	if (bytes > MEMORY_LIMITS.maxSettingsBytes) {
		throw new HttpError(413, `Settings exceed the ${MEMORY_LIMITS.maxSettingsBytes}-byte memory cap.`);
	}

	const now = new Date().toISOString();
	const current = await env.DB.prepare("SELECT revision FROM user_settings WHERE user_id = ?")
		.bind(auth.user.id)
		.first<{ revision: number }>();

	const currentRevision = current?.revision ?? 0;
	if (body.expectedRevision !== undefined && body.expectedRevision !== currentRevision) {
		throw new HttpError(409, `Settings changed elsewhere (expected revision ${body.expectedRevision}, current is ${currentRevision}).`);
	}

	const nextRevision = currentRevision + 1;
	if (!current) {
		await env.DB.prepare(
			"INSERT INTO user_settings (user_id, payload, revision, updated_at) VALUES (?, ?, ?, ?)",
		)
			.bind(auth.user.id, payload, nextRevision, now)
			.run();
	} else {
		const updated = await env.DB.prepare(
			"UPDATE user_settings SET payload = ?, revision = ?, updated_at = ? WHERE user_id = ? AND revision = ?",
		)
			.bind(payload, nextRevision, now, auth.user.id, currentRevision)
			.run();
		if ((updated.meta?.changes ?? 0) === 0) {
			throw new HttpError(409, "Settings were updated concurrently; retry with the latest revision.");
		}
	}

	return jsonOk({ revision: nextRevision, updatedAt: now, bytes });
}

export async function handlePutWatchlist(request: Request, auth: AuthContext, env: Env): Promise<Response> {
	const body = await readBoundedJson(request);
	if (!isRecord(body) || !Array.isArray(body.items)) {
		throw new HttpError(400, "Body must contain an items array.");
	}
	if (body.items.length > MEMORY_LIMITS.maxWatchlistItems) {
		throw new HttpError(413, `Watchlist exceeds the ${MEMORY_LIMITS.maxWatchlistItems}-symbol memory cap.`);
	}

	const now = new Date().toISOString();
	const seen = new Set<string>();
	const normalized: Array<{ symbol: string; notes: string; addedAt: string }> = [];

	for (const entry of body.items) {
		if (!isRecord(entry) || !isValidSymbol(entry.symbol)) {
			throw new HttpError(400, "Each watchlist entry must have a valid ticker symbol.");
		}
		const symbol = entry.symbol.toUpperCase();
		if (seen.has(symbol)) {
			throw new HttpError(400, `Duplicate watchlist symbol: ${symbol}`);
		}
		seen.add(symbol);

		let notes = "";
		if (entry.notes !== undefined && entry.notes !== null) {
			if (typeof entry.notes !== "string") throw new HttpError(400, "Watchlist notes must be a string.");
			if (entry.notes.length > MEMORY_LIMITS.maxWatchlistNoteChars) {
				throw new HttpError(413, `Watchlist note for ${symbol} exceeds ${MEMORY_LIMITS.maxWatchlistNoteChars} characters.`);
			}
			notes = entry.notes;
		}
		const addedAt = typeof entry.addedAt === "string" && !Number.isNaN(Date.parse(entry.addedAt)) ? entry.addedAt : now;
		normalized.push({ symbol, notes, addedAt });
	}

	const statements = [
		env.DB.prepare("DELETE FROM watchlists WHERE user_id = ?").bind(auth.user.id),
		...normalized.map((item) =>
			env.DB.prepare("INSERT INTO watchlists (user_id, symbol, notes, added_at) VALUES (?, ?, ?, ?)").bind(
				auth.user.id,
				item.symbol,
				item.notes,
				item.addedAt,
			),
		),
	];
	await env.DB.batch(statements);

	return jsonOk({ items: normalized, count: normalized.length });
}

export async function handleUpsertTicket(ticketId: string, request: Request, auth: AuthContext, env: Env): Promise<Response> {
	if (!isValidTicketId(ticketId)) {
		throw new HttpError(400, "Ticket id must be 1-64 alphanumeric, hyphen or underscore characters.");
	}
	const body = await readBoundedJson(request);
	if (!isRecord(body) || !isValidSymbol(body.symbol) || !isValidBroker(body.broker) || !isRecord(body.order)) {
		throw new HttpError(400, "Ticket requires valid symbol, broker ('robinhood' | 'fidelity'), label, and order object.");
	}

	const label = typeof body.label === "string" ? body.label.trim() : "";
	if (!label || label.length > MEMORY_LIMITS.maxTicketLabelChars) {
		throw new HttpError(400, `label must be 1-${MEMORY_LIMITS.maxTicketLabelChars} characters.`);
	}

	const payload = JSON.stringify(body.order);
	const bytes = utf8ByteLength(payload);
	if (bytes > MEMORY_LIMITS.maxTicketPayloadBytes) {
		throw new HttpError(413, `Ticket order exceeds the ${MEMORY_LIMITS.maxTicketPayloadBytes}-byte cap.`);
	}

	const existing = await env.DB.prepare("SELECT id, created_at FROM saved_tickets WHERE id = ? AND user_id = ?")
		.bind(ticketId, auth.user.id)
		.first<{ id: string; created_at: string }>();

	if (!existing) {
		const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM saved_tickets WHERE user_id = ?")
			.bind(auth.user.id)
			.first<{ count: number }>();
		if ((countRow?.count ?? 0) >= MEMORY_LIMITS.maxSavedTickets) {
			throw new HttpError(413, `Saved tickets exceed the ${MEMORY_LIMITS.maxSavedTickets}-ticket memory cap.`);
		}
	}

	const symbol = body.symbol.toUpperCase();
	const now = new Date().toISOString();
	const createdAt = existing?.created_at ?? now;

	await env.DB.prepare(
		`INSERT INTO saved_tickets (id, user_id, symbol, label, broker, payload, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, id) DO UPDATE SET
		   symbol = excluded.symbol,
		   label = excluded.label,
		   broker = excluded.broker,
		   payload = excluded.payload,
		   updated_at = excluded.updated_at`,
	)
		.bind(ticketId, auth.user.id, symbol, label, body.broker, payload, createdAt, now)
		.run();

	return jsonOk(
		{
			ticket: {
				id: ticketId,
				symbol,
				label,
				broker: body.broker,
				order: body.order,
				createdAt,
				updatedAt: now,
			},
			bytes,
		},
		existing ? 200 : 201,
	);
}

export async function handleDeleteTicket(ticketId: string, auth: AuthContext, env: Env): Promise<Response> {
	if (!isValidTicketId(ticketId)) {
		throw new HttpError(400, "Invalid ticket id.");
	}
	const result = await env.DB.prepare("DELETE FROM saved_tickets WHERE id = ? AND user_id = ?")
		.bind(ticketId, auth.user.id)
		.run();
	if ((result.meta?.changes ?? 0) === 0) {
		throw new HttpError(404, "Saved ticket not found.");
	}
	return jsonOk({ deleted: true, id: ticketId });
}

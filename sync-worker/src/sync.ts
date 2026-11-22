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

interface WatchlistDocRow {
	payload: string;
	item_count: number;
	revision: number;
	updated_at: string;
}

interface TicketRow {
	id: string;
	symbol: string;
	label: string;
	broker: string;
	payload: string;
	revision: number;
	created_at: string;
	updated_at: string;
}

interface WatchlistItem {
	symbol: string;
	notes: string;
	addedAt: string;
}

function readExpectedRevision(body: Record<string, unknown>): number {
	const value = body.expectedRevision;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new HttpError(400, "expectedRevision must be a non-negative integer (use 0 for the initial write).");
	}
	return value;
}

async function getUsage(db: D1Database, userId: string) {
	const [settingsRow, watchlistRow, ticketsRow] = await Promise.all([
		db.prepare("SELECT payload FROM user_settings WHERE user_id = ?").bind(userId).first<{ payload: string }>(),
		db.prepare("SELECT item_count FROM user_watchlists WHERE user_id = ?").bind(userId).first<{ item_count: number }>(),
		db.prepare("SELECT COUNT(*) AS count FROM saved_tickets WHERE user_id = ? AND deleted_at IS NULL")
			.bind(userId)
			.first<{ count: number }>(),
	]);
	return {
		settingsBytes: settingsRow ? utf8ByteLength(settingsRow.payload) : 0,
		watchlistCount: watchlistRow?.item_count ?? 0,
		savedTicketsCount: ticketsRow?.count ?? 0,
	};
}

export async function handleGetMe(auth: AuthContext, env: Env): Promise<Response> {
	const usage = await getUsage(env.DB, auth.user.id);
	return jsonOk({ user: auth.user, limits: MEMORY_LIMITS, usage });
}

export async function handleGetSync(auth: AuthContext, env: Env): Promise<Response> {
	const [settingsRow, watchlistRow, ticketResult] = await Promise.all([
		env.DB.prepare("SELECT payload, revision, updated_at FROM user_settings WHERE user_id = ?")
			.bind(auth.user.id)
			.first<SettingsRow>(),
		env.DB.prepare("SELECT payload, item_count, revision, updated_at FROM user_watchlists WHERE user_id = ?")
			.bind(auth.user.id)
			.first<WatchlistDocRow>(),
		env.DB.prepare(
			`SELECT id, symbol, label, broker, payload, revision, created_at, updated_at
			 FROM saved_tickets
			 WHERE user_id = ? AND deleted_at IS NULL
			 ORDER BY updated_at DESC`,
		)
			.bind(auth.user.id)
			.all<TicketRow>(),
	]);

	const watchlistItems = watchlistRow ? (JSON.parse(watchlistRow.payload) as WatchlistItem[]) : [];
	const savedTickets = (ticketResult.results ?? []).map((row) => ({
		id: row.id,
		symbol: row.symbol,
		label: row.label,
		broker: row.broker,
		order: JSON.parse(row.payload) as unknown,
		revision: row.revision,
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
		watchlist: watchlistRow
			? {
				items: watchlistItems,
				revision: watchlistRow.revision,
				updatedAt: watchlistRow.updated_at,
			}
			: null,
		savedTickets,
		limits: MEMORY_LIMITS,
		usage: {
			settingsBytes: settingsRow ? utf8ByteLength(settingsRow.payload) : 0,
			watchlistCount: watchlistItems.length,
			savedTicketsCount: savedTickets.length,
		},
	});
}

export async function handlePutSettings(request: Request, auth: AuthContext, env: Env): Promise<Response> {
	const body = await readBoundedJson(request);
	if (!isRecord(body) || !isRecord(body.settings)) {
		throw new HttpError(400, "Body must contain a settings JSON object.");
	}
	const expectedRevision = readExpectedRevision(body);

	const payload = JSON.stringify(body.settings);
	const bytes = utf8ByteLength(payload);
	if (bytes > MEMORY_LIMITS.maxSettingsBytes) {
		throw new HttpError(413, `Settings exceed the ${MEMORY_LIMITS.maxSettingsBytes}-byte memory cap.`);
	}

	const now = new Date().toISOString();
	if (expectedRevision === 0) {
		const inserted = await env.DB.prepare(
			"INSERT INTO user_settings (user_id, payload, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING",
		)
			.bind(auth.user.id, payload, now)
			.run();
		if ((inserted.meta?.changes ?? 0) === 0) {
			throw new HttpError(409, "Settings already exist; retry with the current revision.");
		}
		return jsonOk({ revision: 1, updatedAt: now, bytes });
	}

	const updated = await env.DB.prepare(
		"UPDATE user_settings SET payload = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
	)
		.bind(payload, now, auth.user.id, expectedRevision)
		.run();
	if ((updated.meta?.changes ?? 0) === 0) {
		throw new HttpError(409, `Settings changed elsewhere (expected revision ${expectedRevision}).`);
	}

	return jsonOk({ revision: expectedRevision + 1, updatedAt: now, bytes });
}

export async function handlePutWatchlist(request: Request, auth: AuthContext, env: Env): Promise<Response> {
	const body = await readBoundedJson(request);
	if (!isRecord(body) || !Array.isArray(body.items)) {
		throw new HttpError(400, "Body must contain an items array.");
	}
	const expectedRevision = readExpectedRevision(body);
	if (body.items.length > MEMORY_LIMITS.maxWatchlistItems) {
		throw new HttpError(413, `Watchlist exceeds the ${MEMORY_LIMITS.maxWatchlistItems}-symbol memory cap.`);
	}

	const now = new Date().toISOString();
	const seen = new Set<string>();
	const normalized: WatchlistItem[] = [];

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
		const parsedDate = typeof entry.addedAt === "string" ? Date.parse(entry.addedAt) : Number.NaN;
		// Normalize every timestamp to canonical UTC ISO-8601 so chronological ordering is exact.
		const addedAt = Number.isNaN(parsedDate) ? now : new Date(parsedDate).toISOString();
		normalized.push({ symbol, notes, addedAt });
	}

	normalized.sort((a, b) => (a.addedAt === b.addedAt ? a.symbol.localeCompare(b.symbol) : a.addedAt.localeCompare(b.addedAt)));
	const payload = JSON.stringify(normalized);

	if (expectedRevision === 0) {
		const inserted = await env.DB.prepare(
			"INSERT INTO user_watchlists (user_id, payload, item_count, revision, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING",
		)
			.bind(auth.user.id, payload, normalized.length, now)
			.run();
		if ((inserted.meta?.changes ?? 0) === 0) {
			throw new HttpError(409, "Watchlist already exists; retry with the current revision.");
		}
		return jsonOk({ items: normalized, count: normalized.length, revision: 1, updatedAt: now });
	}

	const updated = await env.DB.prepare(
		"UPDATE user_watchlists SET payload = ?, item_count = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
	)
		.bind(payload, normalized.length, now, auth.user.id, expectedRevision)
		.run();
	if ((updated.meta?.changes ?? 0) === 0) {
		throw new HttpError(409, `Watchlist changed elsewhere (expected revision ${expectedRevision}).`);
	}

	return jsonOk({ items: normalized, count: normalized.length, revision: expectedRevision + 1, updatedAt: now });
}

export async function handleUpsertTicket(ticketId: string, request: Request, auth: AuthContext, env: Env): Promise<Response> {
	if (!isValidTicketId(ticketId)) {
		throw new HttpError(400, "Ticket id must be 1-64 alphanumeric, hyphen or underscore characters.");
	}
	const body = await readBoundedJson(request);
	if (!isRecord(body) || !isValidSymbol(body.symbol) || !isValidBroker(body.broker) || !isRecord(body.order)) {
		throw new HttpError(400, "Ticket requires valid symbol, broker ('robinhood' | 'fidelity'), label, and order object.");
	}
	const expectedRevision = readExpectedRevision(body);

	const label = typeof body.label === "string" ? body.label.trim() : "";
	if (!label || label.length > MEMORY_LIMITS.maxTicketLabelChars) {
		throw new HttpError(400, `label must be 1-${MEMORY_LIMITS.maxTicketLabelChars} characters.`);
	}

	const payload = JSON.stringify(body.order);
	const bytes = utf8ByteLength(payload);
	if (bytes > MEMORY_LIMITS.maxTicketPayloadBytes) {
		throw new HttpError(413, `Ticket order exceeds the ${MEMORY_LIMITS.maxTicketPayloadBytes}-byte cap.`);
	}

	const symbol = body.symbol.toUpperCase();
	const now = new Date().toISOString();

	if (expectedRevision === 0) {
		// Enforce the per-user active ticket cap atomically in the insert.
		const inserted = await env.DB.prepare(
			`INSERT INTO saved_tickets (id, user_id, symbol, label, broker, payload, revision, deleted_at, created_at, updated_at)
			 SELECT ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?
			 WHERE (SELECT COUNT(*) FROM saved_tickets WHERE user_id = ? AND deleted_at IS NULL) < ?
			 ON CONFLICT(user_id, id) DO NOTHING`,
		)
			.bind(
				ticketId,
				auth.user.id,
				symbol,
				label,
				body.broker,
				payload,
				now,
				now,
				auth.user.id,
				MEMORY_LIMITS.maxSavedTickets,
			)
			.run();

		if ((inserted.meta?.changes ?? 0) === 0) {
			const existing = await env.DB.prepare(
				"SELECT revision, deleted_at FROM saved_tickets WHERE user_id = ? AND id = ?",
			)
				.bind(auth.user.id, ticketId)
				.first<{ revision: number; deleted_at: string | null }>();
			if (existing) {
				throw new HttpError(
					409,
					existing.deleted_at
						? "This ticket id was deleted; save under a new id."
						: `Ticket already exists at revision ${existing.revision}.`,
				);
			}
			throw new HttpError(413, `Saved tickets exceed the ${MEMORY_LIMITS.maxSavedTickets}-ticket memory cap.`);
		}

		return jsonOk(
			{
				ticket: {
					id: ticketId,
					symbol,
					label,
					broker: body.broker,
					order: body.order,
					revision: 1,
					createdAt: now,
					updatedAt: now,
				},
				bytes,
			},
			201,
		);
	}

	const updated = await env.DB.prepare(
		`UPDATE saved_tickets
		 SET symbol = ?, label = ?, broker = ?, payload = ?, revision = revision + 1, updated_at = ?
		 WHERE user_id = ? AND id = ? AND deleted_at IS NULL AND revision = ?
		 RETURNING created_at`,
	)
		.bind(symbol, label, body.broker, payload, now, auth.user.id, ticketId, expectedRevision)
		.first<{ created_at: string }>();

	if (!updated) {
		const existing = await env.DB.prepare(
			"SELECT revision, deleted_at FROM saved_tickets WHERE user_id = ? AND id = ?",
		)
			.bind(auth.user.id, ticketId)
			.first<{ revision: number; deleted_at: string | null }>();
		if (!existing) throw new HttpError(404, "Saved ticket not found.");
		throw new HttpError(
			409,
			existing.deleted_at
				? "Saved ticket was already deleted."
				: `Ticket changed elsewhere (expected revision ${expectedRevision}, current is ${existing.revision}).`,
		);
	}

	return jsonOk({
		ticket: {
			id: ticketId,
			symbol,
			label,
			broker: body.broker,
			order: body.order,
			revision: expectedRevision + 1,
			createdAt: updated.created_at,
			updatedAt: now,
		},
		bytes,
	});
}

export async function handleDeleteTicket(ticketId: string, request: Request, auth: AuthContext, env: Env): Promise<Response> {
	if (!isValidTicketId(ticketId)) {
		throw new HttpError(400, "Invalid ticket id.");
	}
	const rawExpected = new URL(request.url).searchParams.get("expectedRevision");
	let expectedRevision: number | null = null;
	if (rawExpected !== null) {
		const parsed = Number(rawExpected);
		if (!Number.isInteger(parsed) || parsed < 1) {
			throw new HttpError(400, "expectedRevision must be a positive integer.");
		}
		expectedRevision = parsed;
	}

	const now = new Date().toISOString();
	const result = expectedRevision === null
		? await env.DB.prepare(
			"UPDATE saved_tickets SET deleted_at = ?, revision = revision + 1, updated_at = ?, payload = '{}' WHERE user_id = ? AND id = ? AND deleted_at IS NULL",
		)
			.bind(now, now, auth.user.id, ticketId)
			.run()
		: await env.DB.prepare(
			"UPDATE saved_tickets SET deleted_at = ?, revision = revision + 1, updated_at = ?, payload = '{}' WHERE user_id = ? AND id = ? AND deleted_at IS NULL AND revision = ?",
		)
			.bind(now, now, auth.user.id, ticketId, expectedRevision)
			.run();

	if ((result.meta?.changes ?? 0) === 0) {
		const existing = await env.DB.prepare("SELECT deleted_at FROM saved_tickets WHERE user_id = ? AND id = ?")
			.bind(auth.user.id, ticketId)
			.first<{ deleted_at: string | null }>();
		if (!existing || existing.deleted_at) throw new HttpError(404, "Saved ticket not found.");
		throw new HttpError(409, "Saved ticket changed elsewhere; refresh before deleting.");
	}
	return jsonOk({ deleted: true, id: ticketId });
}

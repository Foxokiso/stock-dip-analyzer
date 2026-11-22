/** Per-account storage caps enforced by the sync Worker. */
export const MEMORY_LIMITS = {
	maxRequestBytes: 131_072,
	maxSettingsBytes: 65_536,
	maxWatchlistItems: 200,
	maxWatchlistNoteChars: 500,
	maxSavedTickets: 100,
	maxTicketPayloadBytes: 16_384,
	maxTicketLabelChars: 120,
} as const;

const SYMBOL_PATTERN = /^[A-Za-z][A-Za-z0-9.-]{0,9}$/;
const TICKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BROKERS = new Set(["robinhood", "fidelity"]);
const encoder = new TextEncoder();

export class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export function utf8ByteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidSymbol(value: unknown): value is string {
	return typeof value === "string" && SYMBOL_PATTERN.test(value);
}

export function isValidTicketId(value: unknown): value is string {
	return typeof value === "string" && TICKET_ID_PATTERN.test(value);
}

export function isValidBroker(value: unknown): value is "robinhood" | "fidelity" {
	return typeof value === "string" && BROKERS.has(value);
}

const SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
} as const;

export function jsonOk(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: SECURITY_HEADERS });
}

export function jsonError(status: number, error: string): Response {
	return Response.json({ error }, { status, headers: SECURITY_HEADERS });
}

/** Reads a JSON request body up to `maxBytes` without buffering unbounded payloads. */
export async function readBoundedJson(request: Request, maxBytes = MEMORY_LIMITS.maxRequestBytes): Promise<unknown> {
	const declared = request.headers.get("Content-Length");
	if (declared !== null && Number(declared) > maxBytes) {
		void request.body?.cancel().catch(() => {});
		throw new HttpError(413, `Request body exceeds the ${maxBytes}-byte limit.`);
	}
	if (!request.body) {
		throw new HttpError(400, "Request body is required.");
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			void reader.cancel().catch(() => {});
			throw new HttpError(413, `Request body exceeds the ${maxBytes}-byte limit.`);
		}
		chunks.push(value);
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		return JSON.parse(new TextDecoder().decode(merged));
	} catch {
		throw new HttpError(400, "Request body must be valid JSON.");
	}
}

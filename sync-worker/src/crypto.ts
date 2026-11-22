const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generates `byteLength` cryptographically random bytes encoded as lowercase hex. */
export function randomHex(byteLength = 32): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return toHex(bytes);
}

export async function sha256Bytes(value: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return new Uint8Array(digest);
}

export async function sha256Hex(value: string): Promise<string> {
	return toHex(await sha256Bytes(value));
}

/** Constant-time equality comparison over SHA-256 digests of two strings. */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
	const [hashA, hashB] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
	const subtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (left: BufferSource, right: BufferSource) => boolean;
	};
	if (typeof subtle.timingSafeEqual === "function") {
		return subtle.timingSafeEqual(hashA, hashB);
	}
	let diff = 0;
	for (let i = 0; i < hashA.length; i++) {
		diff |= hashA[i] ^ hashB[i];
	}
	return diff === 0;
}

const HTML_CSP = "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const CSS_BODY = `:root { color-scheme: dark; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #090b10; color: #e5e7eb; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
main { max-width: 440px; width: 100%; background: #111622; border: 1px solid #262e40; border-radius: 12px; padding: 28px; box-sizing: border-box; }
.badge { display: inline-block; font-size: 12px; font-weight: 600; border: 1px solid; border-radius: 999px; padding: 2px 10px; margin-bottom: 14px; }
.badge-ok { color: #22c55e; border-color: #22c55e; }
.badge-err { color: #ef4444; border-color: #ef4444; }
.badge-info { color: #38bdf8; border-color: #38bdf8; }
h1 { font-size: 20px; margin: 0 0 10px; }
p { margin: 0 0 14px; color: #9ca3af; line-height: 1.5; font-size: 14px; }
label { display: block; font-size: 13px; color: #d1d5db; margin-bottom: 6px; }
input[type="text"] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 16px; letter-spacing: 0.14em; text-transform: uppercase; font-family: ui-monospace, monospace; background: #090b10; color: #f9fafb; border: 1px solid #374151; border-radius: 8px; margin-bottom: 14px; }
button { width: 100%; padding: 10px 16px; font-size: 14px; font-weight: 600; color: #090b10; background: #38bdf8; border: 0; border-radius: 8px; cursor: pointer; }
.warn { font-size: 12px; color: #fbbf24; margin-top: 12px; margin-bottom: 0; }
.err { font-size: 13px; color: #f87171; margin: 0 0 12px; }`;

function htmlHeaders(extra?: Record<string, string>): Headers {
	const headers = new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy": HTML_CSP,
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
	});
	if (extra) {
		for (const [key, value] of Object.entries(extra)) headers.set(key, value);
	}
	return headers;
}

export function renderStylesheet(): Response {
	return new Response(CSS_BODY, {
		status: 200,
		headers: {
			"Content-Type": "text/css; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

interface HtmlPageOptions {
	title: string;
	heading: string;
	message: string;
	ok: boolean;
	status?: number;
	setCookie?: string;
}

export function renderHtmlPage({ title, heading, message, ok, status = ok ? 200 : 400, setCookie }: HtmlPageOptions): Response {
	const badgeClass = ok ? "badge badge-ok" : "badge badge-err";
	const badgeText = ok ? "Connected" : "Sign-in failed";
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/auth/style.css">
</head>
<body>
<main>
  <div class="${badgeClass}">${badgeText}</div>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(message)}</p>
</main>
</body>
</html>`;
	return new Response(body, { status, headers: htmlHeaders(setCookie ? { "Set-Cookie": setCookie } : undefined) });
}

interface LoginPromptOptions {
	title: string;
	state: string;
	error?: string;
	status?: number;
	setCookie?: string;
}

export function renderLoginPrompt({ title, state, error, status = 200, setCookie }: LoginPromptOptions): Response {
	const errorMarkup = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/auth/style.css">
</head>
<body>
<main>
  <div class="badge badge-info">Verify device</div>
  <h1>Confirm Dip Analyzer PRO sign-in</h1>
  <p>Enter the 8-character verification code shown in your Dip Analyzer PRO desktop window before continuing to GitHub.</p>
  ${errorMarkup}
  <form method="POST" action="/auth/login">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <label for="user_code">Verification code</label>
    <input id="user_code" name="user_code" type="text" autocomplete="one-time-code" placeholder="XXXX-XXXX" required maxlength="16">
    <button type="submit">Continue to GitHub</button>
  </form>
  <p class="warn">Only enter a code shown on your own device. Never approve a link or code sent by someone else.</p>
</main>
</body>
</html>`;
	return new Response(body, { status, headers: htmlHeaders(setCookie ? { "Set-Cookie": setCookie } : undefined) });
}

const HTML_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "no-store",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
} as const;

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
}

export function renderHtmlPage({ title, heading, message, ok, status = ok ? 200 : 400 }: HtmlPageOptions): Response {
	const badgeColor = ok ? "#22c55e" : "#ef4444";
	const badgeText = ok ? "Connected" : "Sign-in failed";
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #090b10; color: #e5e7eb; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
  main { max-width: 440px; width: 100%; background: #111622; border: 1px solid #262e40; border-radius: 12px; padding: 28px; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; color: ${badgeColor}; border: 1px solid ${badgeColor}; border-radius: 999px; padding: 2px 10px; margin-bottom: 14px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  p { margin: 0; color: #9ca3af; line-height: 1.5; font-size: 14px; }
</style>
</head>
<body>
<main>
  <div class="badge">${badgeText}</div>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(message)}</p>
</main>
</body>
</html>`;
	return new Response(body, { status, headers: HTML_HEADERS });
}

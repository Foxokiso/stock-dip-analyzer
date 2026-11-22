import { env } from "cloudflare:workers";
import { handleRequest } from "./router.ts";

export default {
	fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
		return handleRequest(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

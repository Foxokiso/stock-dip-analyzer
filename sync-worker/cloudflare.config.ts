import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "stock-dip-analyzer-sync",
		compatibilityDate: "2026-11-22",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		observability: {
			enabled: true,
			logs: {
				enabled: true,
				headSamplingRate: 1,
			},
			traces: {
				enabled: true,
				headSamplingRate: 0.1,
			},
		},
		env: {
			DB: bindings.d1({
				name: "stock-dip-analyzer-sync",
				id: "d97e3900-6791-4c39-97ef-64db5abd059f",
			}),
			APP_NAME: bindings.text("Dip Analyzer PRO"),
			// GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are read as optional Worker secrets
			// at runtime so the Worker deploys cleanly before OAuth credentials are added.
		},
	},
});

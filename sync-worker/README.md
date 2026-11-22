# Stock Dip Analyzer Sync Worker

Cloudflare Worker + D1 backend for GitHub-authenticated cloud sync (settings, watchlist, and saved Options desk tickets) with explicit per-account memory caps.

## Resources

- **Worker:** `stock-dip-analyzer-sync`
- **D1 database:** `stock-dip-analyzer-sync` (`d97e3900-6791-4c39-97ef-64db5abd059f`)
- **Per-user memory caps:**
  - Settings JSON: 64 KB (`65,536` bytes)
  - Watchlist: `200` symbols (500-char notes each)
  - Saved option tickets: `100` tickets (16 KB order payload each)

## Setup & Commands

```bash
npm install
npm run typecheck
npm test
npm run db:migrate:local
npm run dev
```

Apply remote D1 migrations and deploy:

```bash
npm run db:migrate:remote
npm run deploy
```

## GitHub OAuth Secrets

Create a GitHub OAuth App with:
- **Authorization callback URL:** `https://stock-dip-analyzer-sync.thesolarclubog.workers.dev/auth/callback`

Then upload the secrets without putting them in git (either via a local untracked `.env` file passed to `cf deploy --secrets-file` or `cf workers secrets update` / `npx wrangler secret put`):

```bash
cf deploy --secrets-file .dev.vars
# or:
npx wrangler secret put GITHUB_CLIENT_ID --name stock-dip-analyzer-sync
npx wrangler secret put GITHUB_CLIENT_SECRET --name stock-dip-analyzer-sync
```

For local `cf dev`, copy `.dev.vars.example` to `.dev.vars` (git-ignored) and fill in the local OAuth App values.

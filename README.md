# booth-mailtemp

The live inbox at **https://mail.booth.pp.ua/**: real internet mail for `booth.pp.ua`, with a private inbox for every visitor, running entirely on Cloudflare Workers and D1 (no machine to keep alive). Anyone who types a name sees that inbox (Mailinator style), `name+tag` is its own inbox, the owner reads everything at `/admin` after signing in with GitHub, and visitors can file a problem report from the page.

Author: Booth Ugrit. Release notes: [CHANGELOG.md](CHANGELOG.md).

## The three Workers

| Folder | Worker | What it does |
|---|---|---|
| `cloud/` | `mailtemp-cloud` | Serves the inbox UI and API from Workers Static Assets and keeps mail in D1. Mail reaches it through an RPC method on a Service Binding, never a public route. Owns `mail.booth.pp.ua`, the admin page, the problem report form, the retention cron and `GET /api/status`. |
| `worker/` | `capture-worker` | Cloudflare Email Worker behind Email Routing. Calls `env.CLOUD.ingest(raw, { from, to })` with a 15 s timeout, buffers a failed mail in KV for 7 days and re-ingests it from a 5-minute cron (15 per run, deleted only after success). Also runs the down alert. |
| `status-worker/` | `mailpit-status-fallback` | Answers every path on `mailpit.booth.pp.ua` with a "we moved" page that redirects to `https://mail.booth.pp.ua/` after 10 seconds (JSON `410` for API requests). It never calls an origin. |

`tools/` holds the one-off import and maintenance scripts (see "Tools").

Mail path: Email Routing (catch-all rule) -> `capture-worker` -> `mailtemp-cloud` (D1) -> inbox at `https://mail.booth.pp.ua/`.

## mailtemp-cloud

Mail is stored as an index row, one row per recipient, and the raw message as base64 text chunks of 1,440,000 bytes (a D1 row holds at most 2,000,000). The message view is parsed in the browser from `/api/messages/:id/raw` with a vendored copy of postal-mime (`cloud/public/vendor/postal-mime.js`, MIT-0, version 4.0.7).

Free-tier shape: the UI polls every 10 s with `GET /api/messages?since=<cursor>` (an idle poll reads one D1 row), refreshes fully on switch, on return to the tab, on Refresh and every 5 minutes, slows to 60 s after 15 minutes without input, and polls only while the tab is visible, because every API call counts against the 100,000 requests per day. A cron every 10 minutes deletes the oldest whole messages once stored bytes pass `STORED_BYTES_CAP` (400 MB, under the 500 MB D1 limit) and removes chunks left by a failed ingest.

### Setup (one time, your own Cloudflare account)

1. `cd cloud && npm ci`.
2. Create the database: `npx wrangler d1 create mailtemp-cloud`, then put its id in `database_id` of `cloud/wrangler.toml`.
3. Apply the schema: `npx wrangler d1 migrations apply DB --remote`.
4. Set the session signing key: `npx wrangler secret put SESSION_KEY`.
5. Edit the `[vars]` and the `[[routes]]` custom domain in `cloud/wrangler.toml` for your domain.
6. Deploy the Workers in this order, because `capture-worker` binds to `mailtemp-cloud`: `cloud`, `worker`, `status-worker`.
7. In the Cloudflare dashboard point Email Routing (catch-all) at `capture-worker`.

### Deploy

```
cd cloud && npx wrangler deploy
cd ../worker && npx wrangler deploy
cd ../status-worker && npx wrangler deploy
```

Authenticate with `npx wrangler login` or a scoped `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`. Check a bundle without credentials first with `npx wrangler deploy --dry-run --outdir dist`. Roll back with `npx wrangler rollback <version-id>` in the Worker folder (`npx wrangler versions list` shows the ids).

### Admin and GitHub sign-in

`/admin` lists every message across all names (reserved names such as `qa*`, `h13*` and `root` included) with search over recipient, sender and subject, opens a message (sandboxed HTML, Text, Headers, attachments, `.eml` download), shows storage stats against `STORED_BYTES_CAP`, and deletes selected messages (up to 100 per call). The API is under `/api/admin/*` (`cloud/src/admin.js`).

The only way in is "Sign in with GitHub" (OAuth App, empty scope, so only the public profile is read; the token is used once for `GET /user` and then discarded). Access is decided by the numeric GitHub id, never the login:

- **Owner**: ids in the `OWNER_GITHUB_IDS` var (comma separated). Owners do everything an Admin can, and also list, add (by GitHub username, resolved to the id) and remove admins and read the audit log.
- **Admin**: a row in the `admins` table. Mail, stats and delete only; every owner route answers 403.
- Everyone else gets a 403 page. The role is looked up on every request, so a removed admin is locked out on their next request.

Every delete and every admin change writes an `admin_audit` row (ids and logins only, never mail content). The session is the `mt_admin` cookie (HttpOnly, Secure, SameSite=Strict, 12 h, signed with `SESSION_KEY`); every POST also needs `Content-Type: application/json` and `X-Admin: 1`.

Owner setup:

1. In GitHub open Settings > Developer settings > OAuth Apps > New OAuth App, with Homepage URL `https://mail.booth.pp.ua` and Authorization callback URL `https://mail.booth.pp.ua/api/admin/auth/callback`.
2. Put the client id in `GITHUB_CLIENT_ID` and the owners' numeric ids in `OWNER_GITHUB_IDS` in `cloud/wrangler.toml`.
3. Store the client secret: `cd cloud && npx wrangler secret put GITHUB_CLIENT_SECRET`.
4. Apply `cloud/migrations/0002_admin_roles.sql` (it only creates `admins` and `admin_audit`, `IF NOT EXISTS`) and deploy.

While `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` is missing every `/api/admin/*` answers 404. `GITHUB_OAUTH_BASE` and `GITHUB_API_BASE` exist only so the tests can use a local fake GitHub; leave them unset in production.

### Problem reports and bot check

- Problem reports: the inbox top bar (and the add-address dialog) has a "Report a problem" button that opens a centred form with a category (Bug, Problem, Suggestion, Other), a title (up to 120 characters), details (up to 10,000), an optional from/to time, and 0 to 20 images (file picker, drag and drop or paste; each image is resized in the browser to at most 2,000 px on its long edge and re-encoded as JPEG at quality 0.85 unless that is not smaller, GIFs are sent as they are). `POST /api/report` (`cloud/src/report.js`) takes `multipart/form-data` (fields `category`, `title`, `details`, `from`, `to` as ISO UTC, `route`, and repeated `images` files) because it sends the images as binary instead of base64 inside JSON (no 33 % overhead, no 40 MB string to parse in the Worker). It checks, in this order: configuration (503 while `ISSUES_REPO` or `GITHUB_ISSUES_TOKEN` is missing), size, the rate limit (5 reports per hour per IP, kept in `rate_hits`, 429), the Turnstile token, then the fields (400 or 413): at most 20 images, 5 MB each, 30 MB in total, type decided by magic bytes (png, jpeg, webp, gif; the filename and declared type are ignored). Every `@` in the title, details, page and browser fields becomes `@` plus a zero-width space so nothing can mention anyone, and control and direction-override characters are removed. The images go into the reports repository in one commit through the Git Data API (blobs, tree, commit, fast-forward of the default branch, retried up to 3 times if another report pushed first) under `reports/<yyyy>/<mm>/<yyyymmdd-hhmmss>-<random>/<n>.<ext>`, and the issue (title `[<category>] <title>`, labels `report` and `report:<category>`) embeds them as `![image n](https://github.com/<repo>/blob/<commit>/<path>?raw=true)`, which only members of the private repository can see. The body also lists the time range in Asia/Bangkok and UTC, the active address of the sender's session, the page route (no query string), the browser and the report time. The reply is `{"number": N}` and nothing else; a GitHub failure is a generic 502 and the log records the stage, the HTTP status and GitHub's message only, never a token, an address or report text. A report needs at most 27 subrequests (Turnstile, 20 blobs, repository, branch, tree, commit, ref, issue), below the 50 of the Workers free plan. Nothing is sent back to the reporter and reports cannot be edited or deleted from the page.
- Bot check (Cloudflare Turnstile): while both `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET` (secret) are set, `POST /api/open`, `GET /api/random` and `POST /api/report` need a token in the `X-Turnstile-Token` header, verified with `siteverify` (secret, token and client IP; the answer must be successful, for this host, and for the same action: `open`, `random` or `report`). A missing or rejected token is `403 {"error":"bot check failed"}`; if `siteverify` cannot be reached the request fails closed with 503. The page asks `GET /api/config` for the site key and renders the widget with `appearance: "interaction-only"`, so it is invisible unless Cloudflare wants an interaction; it fetches a fresh token for every add-address, random and report attempt. Scripts that create addresses through the API are blocked by design while this is on. With either value unset nothing is enforced and nothing is loaded from Cloudflare. Reading an inbox, switching and the admin area are not affected. Switch it off at once with `npx wrangler secret delete TURNSTILE_SECRET`.
- Reports and bot check setup (once, by the owner): (1) create a private repository for the reports with at least one commit on its default branch (this deployment uses `ugritchaichana/booth-mailtemp-reports`); (2) in the Cloudflare dashboard open Turnstile, add a widget in Managed mode with the hostname `mail.booth.pp.ua` and copy the site key and the secret key; (3) in GitHub create a fine-grained personal access token (Settings, Developer settings, Personal access tokens, Fine-grained tokens): resource owner `ugritchaichana`, repository access "Only select repositories" with just the reports repository, repository permissions Issues Read and write and Contents Read and write (Metadata read is added automatically), and an expiry (the Worker answers 502 for reports once it lapses, so note the renewal date); (4) set the vars `ISSUES_REPO` (`owner/name`, already `ugritchaichana/booth-mailtemp-reports`) and `TURNSTILE_SITE_KEY` in `cloud/wrangler.toml`; (5) store the two secrets from `cloud/` with `npx wrangler secret put TURNSTILE_SECRET` and `npx wrangler secret put GITHUB_ISSUES_TOKEN` (each asks for its value in your own terminal); (6) deploy. `GITHUB_API_BASE` is shared with the admin sign-in and exists only so the tests can point at a local fake GitHub.

## Service status and outage alerts

`GET /api/status` (no login, always HTTP 200) returns `{"d1":"ok|down","lastIngestAt":"<ISO time>|null","lastIngestAgeSeconds":<n>|null}`.

Every 5-minute cron run of `capture-worker` probes `STATUS_URL` (`https://mail.booth.pp.ua/api/status`, 8 s timeout) and looks at the oldest mail in `CAPTURE_FALLBACK`. A run is healthy when the probe answers HTTP 200, every status field in the JSON (a lowercase word such as `"ok"` or `"down"`) is `"ok"` with at least one such field, and no buffered mail is older than 10 minutes. It posts to a Discord webhook:

- DOWN once, after 2 consecutive failed probes, with the reason;
- a "still DOWN" reminder at most every 2 hours;
- RECOVERED once on the first healthy probe, with the downtime and the number of mails buffered.

Messages never contain mail addresses or content. Setup: `cd worker && npx wrangler secret put ALERT_WEBHOOK_URL` (a Discord webhook URL; without it the monitor logs `MONITOR_DISABLED` and does nothing), and a KV namespace bound as `MONITOR_STATE` (`npx wrangler kv namespace create MONITOR_STATE`, id into `worker/wrangler.toml`). Turn it off with `npx wrangler secret delete ALERT_WEBHOOK_URL`.

## Tools

- `tools/migrate-mailpit-to-cloud.mjs` reads a Mailpit inbox and posts each message to a temporary Worker (`tools/cloud-import-worker/`) that calls `ingest` with the original received time. Set `MAILPIT_USER`, `MAILPIT_PASSWORD`, `IMPORT_URL`, `IMPORT_TOKEN` (`DRY_RUN=1` lists without sending). Delete that Worker when the import is done.
- `tools/backfill-snippets.mjs` fills list snippets for older messages in batches through the Cloudflare API.

## Tests

CI (`.github/workflows/ci.yml`) runs all of these.

- `node --test "cloud/test/*.test.mjs"`: unit tests on a SQLite stand-in for D1.
- `node --test "worker/test/*.test.js"` and `node --test "status-worker/test/*.test.js"`: no dependencies.
- `node cloud/test/integration.mjs`: starts `wrangler dev --local` with a probe Worker that calls `ingest`.
- `node cloud/test/admin-browser.mjs`: drives `/admin` in headless Chromium against the same local `wrangler dev`, signing in through a local fake GitHub (`cloud/test/fake-github.mjs`, served on `localhost` so the callback really is cross-site) as an owner, an admin and an unlisted account. Playwright is a devDependency of `cloud/`; run `npx playwright install chromium` once.
- `node cloud/test/report-integration.mjs`: `wrangler dev --local` with the Cloudflare Turnstile test keys (always-pass `1x00000000000000000000AA` and `1x0000000000000000000000000000000AA`, always-fail secret `2x0000000000000000000000000000000AA`; the Worker calls the real `siteverify`, so it needs outbound network) and a local fake GitHub that implements the Git Data and Issues calls, and files a 20-image report of 30 MB.
- `node cloud/test/report-browser.mjs`: drives the report form, the add-address flow and the Turnstile widget in headless Chromium against the same setup (the real test widget loads from Cloudflare; set `TURNSTILE_WIDGET=stub` to replace only the widget script when the network is unavailable). No test ever writes to a real repository.

Against a deployed copy, set `PROBE_URL`, `PROBE_TOKEN` and `PUBLIC_URL` and run the same scripts: the probe Worker (`cloud/test/probe/`) is deployed only for that check and deleted afterwards.

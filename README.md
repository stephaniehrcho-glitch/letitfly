# HitTheGrid

Live at **https://hitthegrid.app**. (The Worker is `hitthegrid`; the D1 database keeps its original name, `letitfly`.)

Live scoring for long drive events: round robin, divisions, seeded match play with sealed head-to-head entries, and a live Tracker anyone can watch.

Runs on Cloudflare Workers with a D1 database. Hitters and scorekeepers sign in with an email one-time code. No passwords and no app to install.

## What's in here

| Path | What it is |
|---|---|
| `public/index.html` | The app (Tracker, Enter scores, Director) |
| `public/runtime.js` | Browser data layer: talks to `/api`, polls for live updates |
| `src/worker.js` | API: email sign-in, sessions, the event data store and its access rules |
| `migrations/` | D1 database tables |
| `wrangler.jsonc` | Cloudflare settings |

## First-time setup in Cloudflare

1. **Create the database.** Cloudflare dashboard → Storage & Databases → D1 → Create → name it `letitfly`. Copy its **Database ID** into `wrangler.jsonc` (`database_id`), or send it to Claude to commit.
2. **Set the director email.** In `wrangler.jsonc`, put your email in `OWNER_EMAILS`. Anyone signing in with that email gets the Director tab. Separate several with commas.
3. **Let GitHub deploy it.** Every push to `main` runs `.github/workflows/deploy.yml`, which creates the database tables and deploys the Worker. It needs two repository secrets (GitHub → this repo → Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN`: Cloudflare → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template, then add the permission **Account · D1 · Edit**.
   - `CLOUDFLARE_ACCOUNT_ID`: shown on the Cloudflare dashboard home page (Account ID).

   To deploy without a new commit: GitHub → Actions → Deploy to Cloudflare → Run workflow.
4. **Email sign-in codes.** Until email is set up, you can test with on-screen codes: set `DEV_SHOW_CODES` to `"1"` in `wrangler.jsonc`. **Turn it back to `"0"` before sharing the link**, because anyone could sign in as anyone while it's on.
   For real emails: create a free [Resend](https://resend.com) account, verify your domain, create an API key, then in Cloudflare → your `hitthegrid` Worker → Settings → Variables and Secrets → add a **Secret** named `RESEND_API_KEY`. Set `FROM_EMAIL` in `wrangler.jsonc`, e.g. `HitTheGrid <login@hitthegrid.app>`.
5. **Bring over your data.** Sign in with the director email, open Director, and use **Bring over your existing data** with the export file from the earlier version.

## Who can do what

- **Anyone with the link:** watch the Tracker (standings and brackets).
- **Signed-in hitters and scorekeepers:** request access, then enter scores for the hitters the director assigns them (their own facility by default).
- **Director (`OWNER_EMAILS`):** everything, including the Hitter and Facility libraries, which stay private to the director.

## Local development

```
npm install
npx wrangler d1 migrations apply letitfly --local
npx wrangler dev
```

For local sign-in codes on screen, create `.dev.vars` with `DEV_SHOW_CODES=1`.

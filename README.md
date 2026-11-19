# HitTheGrid

Live at **https://hitthegrid.app**. (The Worker is `hitthegrid`; the D1 database keeps its original name, `letitfly`.)

Live scoring for long drive events: round robin, divisions, seeded match play with sealed head-to-head entries, and a live Tracker anyone can watch.

Runs on Cloudflare Workers with a D1 database. Hitters and scorekeepers sign in with an email one-time code. No passwords and no app to install.

## What's in here

| Path | What it is |
|---|---|
| `public/index.html` | The app (Tracker, Enter scores, Director) |
| `public/runtime.js` | Browser data layer: live connection, offline outbox, `/api` calls |
| `src/worker.js` | API: email sign-in, sessions, the event data store and its access rules, and the `Hub` Durable Object that pushes live updates |
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

- **Everyone starts at a welcome screen:** I'm a hitter / I'm an authorized scorekeeper (email sign-in) or I'm a spectator (event code). Nothing about an event is shown or sent until someone signs in or enters the code.
- **Spectators with the event code:** watch the Tracker only, no account needed. The director finds the code (and a shareable link, `hitthegrid.app/?event=CODE`) in Director → Event Flow. Codes follow the event date, e.g. `Nov10-2026-1`.
- **Signed-in hitters and scorekeepers:** request access, then enter scores for the hitters the director assigns them (their own facility by default).
- **Director (`OWNER_EMAILS`):** everything, including the Hitter and Facility libraries, which stay private to the director.

## Local development

```
npm install
npx wrangler d1 migrations apply letitfly --local
npx wrangler dev
```

For local sign-in codes on screen, create `.dev.vars` with `DEV_SHOW_CODES=1`.

## During an event

- **Live updates:** every open phone keeps one connection to the `Hub` Durable Object, which pushes each saved change to everyone within a fraction of a second. If a connection drops it reconnects on its own, and a slow background check catches anything missed.
- **No signal:** entries are saved on the phone and sent automatically when the connection returns. A banner shows what's waiting. Keep the page open until it clears.
- **Late entries:** the server stamps when each entry arrives and whether it was held on a phone by a connection problem (and for how long, measured on the phone's own clock). Every late entry is listed under Log → Late entries.
- **Duplicate entries:** match play counts the sealed entry the server received first; a later one is set aside and shown in Match control, where the director can use it instead. Round robin counts the latest number typed, and a red ! marks any set where two people entered different numbers.
- **Past events:** Tracker → Past events lists every finished event with its division winners. Anyone signed in (or a spectator with the current code) can open one read-only. The director can make a past event the current one again; the event showing at that moment is saved to Past events first.
- **Backups:** Director → Backup & Print → Download backup (loads back in through "Bring over your existing data"), plus CSV results for round robin and match play.
- **Paper fallback:** Director → Backup & Print → Open printable sheets: roster and round robin sheet plus a sheet per division, with any scores already entered filled in.
- **A change breaks something:** Cloudflare → Workers & Pages → hitthegrid → Deployments → roll back to the previous version.

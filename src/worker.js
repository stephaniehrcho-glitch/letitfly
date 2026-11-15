// HitTheGrid API worker: email one-time-code sign-in, sessions, and a small
// JSON document store (D1) with per-path read/write rules. Static files in
// /public are served by Cloudflare's asset handler before this code runs.

const SESSION_COOKIE = "lif_s";
const SESSION_DAYS = 60;   // signed out only after this many days without using the app
const COOKIE_DAYS = 400;   // browser cookie lifetime (the most browsers allow)
const CODE_MINUTES = 10;
const CODE_RESEND_SECONDS = 30;
const MAX_CODE_ATTEMPTS = 5;
const MAX_DOC_BYTES = 900_000;

// Collections a signed-in hitter or scorekeeper may write, only at <coll>/<their id>.
const SELF_WRITE = new Set(["joins", "rr", "commits", "reveals", "vault"]);
// What a spectator with the event code can read: enough to draw the Tracker.
const SPECTATOR_READ = new Set(["event", "admin", "rr", "commits", "reveals"]);
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
// Collections only the director can read (vault: director, or the owner of that doc).
const OWNER_READ = new Set(["private"]);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: "Server error" }, 500);
    }
  },
};

async function route(req, env, url) {
  const p = url.pathname, m = req.method;
  if (m !== "GET" && m !== "HEAD") {
    // Same-origin check for anything that changes state.
    const origin = req.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Bad origin" }, 403);
  }
  const me = await currentUser(req, env);

  if (p === "/api/me" && m === "GET") return json(me ? publicMe(me, env) : { id: null });
  if (p === "/api/me" && m === "POST") {
    if (!me) return json({ error: "Sign in first" }, 401);
    const { name } = await body(req);
    const n = String(name || "").trim().slice(0, 80);
    if (!n) return json({ error: "Name is required" }, 400);
    await env.DB.prepare("UPDATE users SET name=? WHERE id=?").bind(n, me.id).run();
    return json(publicMe({ ...me, name: n }, env));
  }
  if (p === "/api/auth/start" && m === "POST") return authStart(req, env);
  if (p === "/api/auth/verify" && m === "POST") return authVerify(req, env, url);
  if (p === "/api/auth/logout" && m === "POST") {
    const t = cookie(req, SESSION_COOKIE);
    if (t) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha(t)).run();
    return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
  }
  if (p === "/api/auth/signout-others" && m === "POST") {
    // Director only: a new event starts, so everyone else signs in fresh.
    if (!me || !isOwnerEmail(env, me.email)) return json({ error: "Director only" }, 403);
    const rs = await env.DB.prepare("SELECT s.token_hash, u.email FROM sessions s JOIN users u ON u.id=s.user_id").all();
    const drop = (rs.results || []).filter((r) => !isOwnerEmail(env, r.email)).map((r) => r.token_hash);
    for (let i = 0; i < drop.length; i += 90) {
      const chunk = drop.slice(i, i + 90);
      await env.DB.prepare(`DELETE FROM sessions WHERE token_hash IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
    }
    return json({ ok: true, signedOut: drop.length });
  }
  if (p === "/api/sync" && m === "GET") return sync(env, me, url);
  if (p === "/api/doc" && (m === "PUT" || m === "DELETE")) return writeDoc(req, env, me, url);
  if (p === "/api/profiles" && m === "POST") return profiles(req, env, me);
  if (p === "/api/import" && m === "POST") return importDocs(req, env, me);
  return json({ error: "Not found" }, 404);
}

/* ---------- auth ---------- */

function isOwnerEmail(env, email) {
  const list = String(env.OWNER_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  return list.includes(String(email || "").toLowerCase());
}
const publicMe = (u, env) => ({ id: u.id, email: u.email, name: u.name, isOwner: isOwnerEmail(env, u.email) });
const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

async function authStart(req, env) {
  const email = normEmail((await body(req)).email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address" }, 400);
  const now = Date.now();
  const prev = await env.DB.prepare("SELECT sent_at FROM login_codes WHERE email=?").bind(email).first();
  if (prev && now - prev.sent_at < CODE_RESEND_SECONDS * 1000)
    return json({ error: "A code was just sent. Wait a few seconds before asking for another." }, 429);
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await env.DB.prepare(
    "INSERT INTO login_codes(email,code_hash,expires_at,attempts,sent_at) VALUES(?,?,?,0,?) " +
    "ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at"
  ).bind(email, await sha(email + ":" + code), now + CODE_MINUTES * 60_000, now).run();

  if (env.RESEND_API_KEY) {
    const ok = await sendCode(env, email, code);
    if (!ok) return json({ error: "Couldn't send the email. Try again in a minute." }, 502);
    return json({ ok: true });
  }
  // Testing mode only: no email service yet, so hand the code back on screen.
  if (env.DEV_SHOW_CODES === "1") return json({ ok: true, devCode: code });
  return json({ error: "Email sign-in isn't set up yet (missing RESEND_API_KEY)." }, 503);
}

async function sendCode(env, email, code) {
  const app = env.APP_NAME || "Hit The Grid";
  const from = env.FROM_EMAIL || `${app} <login@hitthegrid.app>`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#13201a">
    <p>Your ${app} sign-in code is</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p>
    <p style="color:#5b6b62">It expires in ${CODE_MINUTES} minutes. If you didn't ask for it, ignore this email.</p></div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject: `${code} is your ${app} code`, html,
      text: `Your ${app} sign-in code is ${code}. It expires in ${CODE_MINUTES} minutes.` }),
  });
  if (!r.ok) console.error("resend", r.status, await r.text());
  return r.ok;
}

async function authVerify(req, env, url) {
  const b = await body(req);
  const email = normEmail(b.email), code = String(b.code || "").replace(/\D/g, "");
  const row = await env.DB.prepare("SELECT * FROM login_codes WHERE email=?").bind(email).first();
  const now = Date.now();
  if (!row || row.expires_at < now) return json({ error: "That code has expired. Ask for a new one." }, 400);
  if (row.attempts >= MAX_CODE_ATTEMPTS) return json({ error: "Too many tries. Ask for a new code." }, 429);
  if (row.code_hash !== (await sha(email + ":" + code))) {
    await env.DB.prepare("UPDATE login_codes SET attempts=attempts+1 WHERE email=?").bind(email).run();
    return json({ error: "That code doesn't match." }, 400);
  }
  await env.DB.prepare("DELETE FROM login_codes WHERE email=?").bind(email).run();

  let user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
  if (!user) {
    user = { id: "u_" + rand(12), email, name: String(b.name || "").trim().slice(0, 80), created_at: now };
    await env.DB.prepare("INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)")
      .bind(user.id, user.email, user.name, user.created_at).run();
  }
  const token = rand(32);
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .bind(await sha(token), user.id, now + SESSION_DAYS * 86_400_000).run();
  // Housekeeping.
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now).run();
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return json(publicMe(user, env), 200, {
    "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly${secure}; SameSite=Lax`,
  });
}

async function currentUser(req, env) {
  const t = cookie(req, SESSION_COOKIE);
  if (!t) return null;
  const h = await sha(t), now = Date.now();
  const row = await env.DB.prepare(
    "SELECT u.*, s.expires_at AS s_exp FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?"
  ).bind(h, now).first();
  if (!row) return null;
  // Sliding sign-in: anyone using the app keeps being renewed, so nobody is
  // signed out mid-event. Only 60 days without opening the app ends a session.
  if (row.s_exp - now < (SESSION_DAYS - 1) * 86_400_000)
    await env.DB.prepare("UPDATE sessions SET expires_at=? WHERE token_hash=?").bind(now + SESSION_DAYS * 86_400_000, h).run();
  const { s_exp, ...user } = row;
  return user;
}

/* ---------- documents ---------- */

function canRead(path, me, env) {
  const [coll, id] = path.split("/");
  const owner = me && isOwnerEmail(env, me.email);
  if (OWNER_READ.has(coll)) return owner;
  if (coll === "vault") return owner || (me && id === me.id);
  return true;
}
function canWrite(path, me, env) {
  if (!me) return false;
  if (isOwnerEmail(env, me.email)) return true;
  const parts = path.split("/");
  return parts.length === 2 && SELF_WRITE.has(parts[0]) && parts[1] === me.id;
}
const validPath = (p) => typeof p === "string" && /^[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_.:~#-]{1,120}$/.test(p);

async function sync(env, me, url) {
  // Signed-out visitors see nothing, unless they give the current event's
  // spectator code, which unlocks the Tracker data only.
  let spectator = false;
  if (!me) {
    const code = normCode(url.searchParams.get("code"));
    if (!code) return json({ now: Date.now(), docs: [], me: null });
    const ev = await env.DB.prepare("SELECT data FROM docs WHERE path='event/main'").first();
    const evCode = ev && ev.data ? normCode(JSON.parse(ev.data).code) : "";
    if (!evCode || evCode !== code) return json({ error: "That code doesn't match a current event." }, 404);
    spectator = true;
  }
  const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
  const now = Date.now();
  const rs = await env.DB.prepare("SELECT path,data,updated_at FROM docs WHERE updated_at>? ORDER BY updated_at")
    .bind(since).all();
  const docs = [];
  for (const r of rs.results || []) {
    if (spectator ? !SPECTATOR_READ.has(r.path.split("/")[0]) : !canRead(r.path, me, env)) continue;
    docs.push({ p: r.path, d: r.data == null ? null : JSON.parse(r.data), t: r.updated_at });
  }
  return json({ now, docs, me: me ? publicMe(me, env) : null, spectator });
}

async function writeDoc(req, env, me, url) {
  const del = req.method === "DELETE";
  const b = del ? { path: url.searchParams.get("path") } : await body(req);
  const path = b.path;
  if (!validPath(path)) return json({ error: "Bad path" }, 400);
  if (!me) return json({ error: "Sign in first" }, 401);
  if (!canWrite(path, me, env)) return json({ error: "Not allowed" }, 403);
  const data = del ? null : JSON.stringify(b.data ?? {});
  if (data && data.length > MAX_DOC_BYTES) return json({ error: "Document too large" }, 413);
  const t = await nextStamp(env);
  await env.DB.prepare(
    "INSERT INTO docs(path,coll,data,updated_at,updated_by) VALUES(?,?,?,?,?) " +
    "ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by"
  ).bind(path, path.split("/")[0], data, t, me.id).run();
  return json({ ok: true, t });
}

// Strictly increasing timestamps so polling clients never miss a write.
async function nextStamp(env) {
  const r = await env.DB.prepare("SELECT MAX(updated_at) AS m FROM docs").first();
  return Math.max(Date.now(), (r && r.m ? r.m : 0) + 1);
}

async function profiles(req, env, me) {
  if (!me) return json({});
  const ids = [].concat((await body(req)).ids || []).filter((x) => typeof x === "string").slice(0, 500);
  if (!ids.length) return json({});
  const owner = me && isOwnerEmail(env, me.email);
  const out = {};
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rs = await env.DB.prepare(`SELECT id,email,name FROM users WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk).all();
    for (const u of rs.results || [])
      out[u.id] = { name: u.name || u.email.split("@")[0], email: owner || (me && me.id === u.id) ? u.email : "" };
  }
  return json(out);
}

// Director-only: load data exported from the earlier version of the app.
// Body: { docs: { "<path>": data, ... }, remap: { "<old user id>": "<new user id>" } }
async function importDocs(req, env, me) {
  if (!me || !isOwnerEmail(env, me.email)) return json({ error: "Director only" }, 403);
  const b = await body(req, 5_000_000);
  let text = JSON.stringify(b.docs || {});
  for (const [from, to] of Object.entries(b.remap || {})) {
    if (!/^[\w-]+$/.test(from) || !/^[\w-]+$/.test(String(to))) continue;
    text = text.split(from).join(to);
  }
  const docs = JSON.parse(text);
  const stmts = [];
  for (const [path, data] of Object.entries(docs)) {
    if (!validPath(path)) continue;
    const t = await nextStamp(env) + stmts.length;
    stmts.push(env.DB.prepare(
      "INSERT INTO docs(path,coll,data,updated_at,updated_by) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by"
    ).bind(path, path.split("/")[0], JSON.stringify(data), t, me.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, imported: stmts.length });
}

/* ---------- helpers ---------- */

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
async function body(req, limit = 1_000_000) {
  const t = await req.text();
  if (t.length > limit) throw new Error("Body too large");
  try { return t ? JSON.parse(t) : {}; } catch { return {}; }
}
function cookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  const m = h.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function rand(n) {
  const a = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...crypto.getRandomValues(new Uint8Array(n))].map((x) => a[x % a.length]).join("");
}

// Browser side of Hit The Grid's data layer. Gives the app the same small API
// it used before (db.doc/collection with onSnapshot, user.me/profiles), backed
// by the /api routes.
//
// Live updates: one WebSocket to /api/live; the server pushes every change the
// moment it's saved. A slow /api/sync check runs as a backup, and takes over at
// a fast pace whenever the live connection is down.
//
// Offline-safe saves: every write goes into an outbox kept on this device
// (localStorage). If the network is down it stays there and is sent, in order,
// as soon as the connection is back. The app shows it as saved straight away.
(function () {
  const store = new Map();        // path -> data
  const docSubs = new Map();      // path -> Set(fn)
  const colSubs = new Map();      // coll -> Set(fn)
  let since = 0, synced = false, me = null, polling = null;

  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };

  // Spectator event code: from ?event=CODE in the link, or remembered on this device.
  let code = null;
  try {
    const q = new URLSearchParams(location.search).get("event");
    if (q) { ls.set("htg_code", q); history.replaceState(null, "", location.pathname + location.hash); }
  } catch {}
  code = ls.get("htg_code");

  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const snapDoc = (p) => {
    const d = store.get(p);
    return { exists: d != null, id: p.split("/").pop(), data: () => clone(d), metadata: { fromCache: !synced } };
  };
  const snapCol = (c) => ({
    docs: [...store.keys()].filter((k) => k.split("/")[0] === c && k.split("/").length === 2)
      .map((k) => ({ id: k.split("/")[1], data: () => clone(store.get(k)) })),
  });
  function notify(paths) {
    const colls = new Set();
    for (const p of paths) {
      (docSubs.get(p) || []).forEach((f) => f(snapDoc(p)));
      colls.add(p.split("/")[0]);
    }
    for (const c of colls) (colSubs.get(c) || []).forEach((f) => f(snapCol(c)));
  }

  async function api(path, opts = {}) {
    let r;
    try {
      r = await fetch(path, {
        credentials: "same-origin",
        headers: opts.body ? { "Content-Type": "application/json" } : {},
        ...opts,
      });
    } catch (e) {
      throw Object.assign(new Error("No connection"), { network: true });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "Request failed"), { status: r.status });
    return j;
  }
  const retryable = (e) => e.network || e.status >= 500 || e.status === 429;

  /* ---------- connection status ---------- */
  const status = { online: true, live: false, pending: 0 };
  function setStatus(ch) {
    const before = JSON.stringify(status);
    Object.assign(status, ch, { pending: outbox.length });
    if (JSON.stringify(status) !== before) window.dispatchEvent(new CustomEvent("htg-status", { detail: { ...status } }));
  }

  /* ---------- outbox ---------- */
  let outbox = [];                  // [{ path, data, del, id }]
  let flushing = false, flushTimer = null, inFlight = null;
  const obKey = () => "htg_outbox_" + (me ? me.id : "anon");
  const saveOutbox = () => ls.set(obKey(), outbox.length ? JSON.stringify(outbox) : null);
  const pendingPaths = () => new Set(outbox.map((e) => e.path));
  const waiters = new Map();        // entry id -> {resolve, reject}

  function enqueue(path, data, del) {
    const id = Math.random().toString(36).slice(2);
    // A newer save for the same document replaces a waiting one (not one being sent).
    const i = outbox.findIndex((e) => e.path === path && e.id !== inFlight);
    const entry = { path, data: del ? null : data, del: !!del, id };
    if (i >= 0) { const old = outbox[i]; outbox[i] = entry; settle(old.id, null, { replaced: true }); }
    else outbox.push(entry);
    saveOutbox();
    setStatus({});
    return new Promise((resolve, reject) => { waiters.set(id, { resolve, reject }); flush(); });
  }
  function settle(id, err, val) {
    const w = waiters.get(id); if (!w) return;
    waiters.delete(id);
    err ? w.reject(err) : w.resolve(val);
  }
  async function flush() {
    if (flushing || !outbox.length) return;
    flushing = true; clearTimeout(flushTimer);
    while (outbox.length) {
      const e = outbox[0]; inFlight = e.id;
      try {
        if (e.del) await api("/api/doc?path=" + encodeURIComponent(e.path), { method: "DELETE" });
        else await api("/api/doc", { method: "PUT", body: JSON.stringify({ path: e.path, data: e.data }) });
        outbox.shift(); saveOutbox(); settle(e.id, null, { sent: true });
        setStatus({ online: true });
      } catch (err) {
        if (retryable(err)) {
          // Keep it on the phone; the app treats it as saved and it goes out later.
          for (const x of outbox) settle(x.id, null, { queued: true });
          setStatus({ online: false });
          flushTimer = setTimeout(flush, 4000);
          break;
        }
        // Refused for good (not allowed, signed out, too large): undo it locally.
        outbox.shift(); saveOutbox(); settle(e.id, err);
        resync(e.path);
      }
    }
    inFlight = null; flushing = false; setStatus({});
  }
  // After a refused save, put the server's copy back.
  function resync(path) { since = 0; store.delete(path); notify([path]); poll(); }

  /* ---------- applying changes from the server ---------- */
  function apply(docs, now) {
    const skip = pendingPaths(), changed = [];
    for (const { p, d } of docs) {
      if (skip.has(p)) continue;                 // our unsent save wins until it's sent
      if (JSON.stringify(store.get(p)) === JSON.stringify(d)) continue;
      if (d == null) store.delete(p); else store.set(p, d);
      changed.push(p);
    }
    if (now) since = Math.max(since, now);
    if (!synced) {
      synced = true;
      for (const e of outbox) { if (e.del) store.delete(e.path); else store.set(e.path, clone(e.data)); }
      docSubs.forEach((set, p) => set.forEach((f) => f(snapDoc(p))));
      colSubs.forEach((set, c) => set.forEach((f) => f(snapCol(c))));
    } else if (changed.length) notify(changed);
  }

  function codeInvalid(msg) {
    code = null; ls.set("htg_code", null);
    window.dispatchEvent(new CustomEvent("htg-code-invalid", { detail: msg }));
  }
  function signedOutElsewhere() { ls.set("htg_me", null); location.hash = ""; location.reload(); }

  async function poll() {
    clearTimeout(polling);
    try {
      // Small overlap so a write landing at the same moment is never skipped.
      const j = await api("/api/sync?since=" + Math.max(0, since - 2000) + (code ? "&code=" + encodeURIComponent(code) : ""));
      if (me && !j.me && !j.spectator) return signedOutElsewhere();
      apply(j.docs, j.now);
      setStatus({ online: true });
      if (outbox.length) flush();
    } catch (e) {
      if (e.status === 404 && code) codeInvalid(e.message);
      if (retryable(e)) setStatus({ online: false });
    }
    // Live connection up: just a slow safety check. Down: check often.
    polling = setTimeout(poll, status.live ? 30000 : document.hidden ? 15000 : 2500);
  }

  /* ---------- live connection ---------- */
  let ws = null, wsTries = 0, wsTimer = null, pingTimer = null;
  function connect() {
    if (ws || !(me || code)) return;
    clearTimeout(wsTimer);
    let sock;
    try {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      sock = new WebSocket(proto + "//" + location.host + "/api/live" + (code && !me ? "?code=" + encodeURIComponent(code) : ""));
    } catch { return retryLater(); }
    ws = sock;
    sock.onopen = () => {
      wsTries = 0; setStatus({ live: true, online: true });
      clearInterval(pingTimer); pingTimer = setInterval(() => { try { sock.send("ping"); } catch {} }, 25000);
      poll();                                   // catch up on anything missed while disconnected
      if (outbox.length) flush();
    };
    sock.onmessage = (ev) => {
      if (ev.data === "pong") return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "docs") apply(m.docs, m.now);
      else if (m.type === "signedout") signedOutElsewhere();
      else if (m.type === "codeinvalid") codeInvalid("That event code isn't active any more.");
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      clearInterval(pingTimer);
      setStatus({ live: false });
      clearTimeout(polling); polling = setTimeout(poll, 1000);
      retryLater();
    };
    sock.onerror = () => { try { sock.close(); } catch {} };
  }
  function retryLater() {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** wsTries++));
  }
  function wake() {
    if (document.hidden) return;
    clearTimeout(polling); poll();
    if (!ws) { wsTries = 0; connect(); }
    if (outbox.length) flush();
  }
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("offline", () => setStatus({ online: false }));

  /* ---------- the app's data API ---------- */
  function put(path, data) {
    store.set(path, clone(data));
    notify([path]);
    return enqueue(path, clone(data), false);
  }

  const db = {
    doc: (p) => ({
      get: async () => snapDoc(p),
      set: (d) => put(p, d),
      update: (d) => put(p, Object.assign({}, store.get(p) || {}, d)),
      delete: () => { store.delete(p); notify([p]); return enqueue(p, null, true); },
      onSnapshot: (next) => {
        if (!docSubs.has(p)) docSubs.set(p, new Set());
        docSubs.get(p).add(next);
        if (synced) setTimeout(() => next(snapDoc(p)), 0);
        return () => docSubs.get(p).delete(next);
      },
    }),
    collection: (c) => ({
      doc: (k) => db.doc(c + "/" + k),
      onSnapshot: (next) => {
        if (!colSubs.has(c)) colSubs.set(c, new Set());
        colSubs.get(c).add(next);
        if (synced) setTimeout(() => next(snapCol(c)), 0);
        return () => colSubs.get(c).delete(next);
      },
    }),
  };

  // Who's signed in. Remembered on the device so a reload with no signal still
  // knows whose unsent entries these are.
  const mePromise = api("/api/me")
    .then((j) => { me = j.id ? j : null; ls.set("htg_me", me ? JSON.stringify(me) : null); return me; })
    .catch((e) => {
      if (e.network) { try { me = JSON.parse(ls.get("htg_me") || "null"); } catch { me = null; } if (me) setStatus({ online: false }); }
      else me = null;
      return me;
    });
  const user = {
    me: async () => { await mePromise; return me ? { id: me.id, isOwner: !!me.isOwner } : { id: null, isOwner: false }; },
    isOwner: async () => { await mePromise; return !!(me && me.isOwner); },
    id: async () => { await mePromise; return me ? me.id : null; },
    profiles: (ids) => api("/api/profiles", { method: "POST", body: JSON.stringify({ ids: [].concat(ids) }) }),
  };

  window.LIF = {
    me: async () => { await mePromise; return me; },
    status: () => ({ ...status, pending: outbox.length }),
    startLogin: (email) => api("/api/auth/start", { method: "POST", body: JSON.stringify({ email }) }),
    verifyLogin: (email, code, name) => api("/api/auth/verify", { method: "POST", body: JSON.stringify({ email, code, name }) }),
    setName: (name) => api("/api/me", { method: "POST", body: JSON.stringify({ name }) }),
    logout: async () => {
      if (outbox.length) await flush();
      ls.set("htg_me", null);
      return api("/api/auth/logout", { method: "POST" });
    },
    signOutOthers: () => api("/api/auth/signout-others", { method: "POST" }),
    getCode: () => code,
    // Checks a spectator code against the server, then remembers it on this device.
    useCode: async (c) => {
      const clean = String(c || "").trim();
      await api("/api/sync?since=" + Date.now() + "&code=" + encodeURIComponent(clean));
      ls.set("htg_code", clean); code = clean;
    },
    leaveEvent: () => { ls.set("htg_code", null); code = null; },
    role: (r) => { if (r !== undefined) ls.set("htg_role", r); return ls.get("htg_role"); },
    importDocs: (docs, remap) => api("/api/import", { method: "POST", body: JSON.stringify({ docs, remap }) }),
    backup: () => api("/api/backup"),
  };

  window.claude = { use: async (n) => (n === "db" ? db : n === "user" ? user : null) };

  // Start: learn who this is, restore any unsent saves, then sync and go live.
  mePromise.then(() => {
    try { outbox = JSON.parse(ls.get(obKey()) || "[]"); } catch { outbox = []; }
    setStatus({});
    poll();
    connect();
  });
})();

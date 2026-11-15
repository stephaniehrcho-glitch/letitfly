// Browser side of HitTheGrid's data layer. Gives the app the same small API it
// used before (db.doc/collection with onSnapshot, user.me/profiles), backed by
// the /api routes. Changes from other devices arrive by polling /api/sync.
(function () {
  const store = new Map();        // path -> data
  const docSubs = new Map();      // path -> Set(fn)
  const colSubs = new Map();      // coll -> Set(fn)
  let since = 0, synced = false, me = null, polling = null;
  // Spectator event code: from ?event=CODE in the link, or remembered on this device.
  const store_ = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
  let code = null;
  try {
    const q = new URLSearchParams(location.search).get("event");
    if (q) { store_.set("htg_code", q); history.replaceState(null, "", location.pathname + location.hash); }
  } catch {}
  code = store_.get("htg_code");

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
    const r = await fetch(path, {
      credentials: "same-origin",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      ...opts,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "Request failed"), { status: r.status });
    return j;
  }

  async function poll() {
    try {
      // Small overlap so a write landing at the same moment is never skipped.
      const j = await api("/api/sync?since=" + Math.max(0, since - 2000) + (code ? "&code=" + encodeURIComponent(code) : ""));
      const changed = [];
      for (const { p, d } of j.docs) {
        const cur = store.get(p);
        if (JSON.stringify(cur) === JSON.stringify(d)) continue;
        if (d == null) store.delete(p); else store.set(p, d);
        changed.push(p);
      }
      // Signed out elsewhere (the director started a new event): start fresh.
      if (me && !j.me && !j.spectator) { location.hash = ""; location.reload(); return; }
      since = j.now;
      const first = !synced;
      synced = true;
      if (first) {
        docSubs.forEach((set, p) => set.forEach((f) => f(snapDoc(p))));
        colSubs.forEach((set, c) => set.forEach((f) => f(snapCol(c))));
      } else if (changed.length) notify(changed);
    } catch (e) {
      if (e.status === 404 && code) {
        // Code no longer matches (reset by the director, or a new event started).
        code = null; store_.set("htg_code", null);
        window.dispatchEvent(new CustomEvent("htg-code-invalid", { detail: e.message }));
      }
      console.warn("sync", e);
    }
    clearTimeout(polling);
    polling = setTimeout(poll, document.hidden ? 15000 : 2500);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { clearTimeout(polling); poll(); } });

  async function put(path, data) {
    const prev = store.get(path);
    store.set(path, clone(data));
    notify([path]);
    try {
      await api("/api/doc", { method: "PUT", body: JSON.stringify({ path, data }) });
    } catch (e) {
      if (prev == null) store.delete(path); else store.set(path, prev);
      notify([path]);
      throw e;
    }
  }

  const db = {
    doc: (p) => ({
      get: async () => snapDoc(p),
      set: (d) => put(p, d),
      update: (d) => put(p, Object.assign({}, store.get(p) || {}, d)),
      delete: async () => {
        const prev = store.get(p);
        store.delete(p); notify([p]);
        try { await api("/api/doc?path=" + encodeURIComponent(p), { method: "DELETE" }); }
        catch (e) { if (prev != null) { store.set(p, prev); notify([p]); } throw e; }
      },
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

  const mePromise = api("/api/me").then((j) => (me = j.id ? j : null)).catch(() => (me = null));
  const user = {
    me: async () => { await mePromise; return me ? { id: me.id, isOwner: !!me.isOwner } : { id: null, isOwner: false }; },
    isOwner: async () => { await mePromise; return !!(me && me.isOwner); },
    id: async () => { await mePromise; return me ? me.id : null; },
    profiles: (ids) => api("/api/profiles", { method: "POST", body: JSON.stringify({ ids: [].concat(ids) }) }),
  };

  // Sign-in helpers used by the app's sign-in panel and account menu.
  window.LIF = {
    me: async () => { await mePromise; return me; },
    startLogin: (email) => api("/api/auth/start", { method: "POST", body: JSON.stringify({ email }) }),
    verifyLogin: (email, code, name) => api("/api/auth/verify", { method: "POST", body: JSON.stringify({ email, code, name }) }),
    setName: (name) => api("/api/me", { method: "POST", body: JSON.stringify({ name }) }),
    logout: () => api("/api/auth/logout", { method: "POST" }),
    signOutOthers: () => api("/api/auth/signout-others", { method: "POST" }),
    getCode: () => code,
    // Checks a spectator code against the server, then remembers it on this device.
    useCode: async (c) => {
      const clean = String(c || "").trim();
      await api("/api/sync?since=" + Date.now() + "&code=" + encodeURIComponent(clean));
      store_.set("htg_code", clean); code = clean;
    },
    leaveEvent: () => { store_.set("htg_code", null); code = null; },
    role: (r) => { if (r !== undefined) store_.set("htg_role", r); return store_.get("htg_role"); },
    importDocs: (docs, remap) => api("/api/import", { method: "POST", body: JSON.stringify({ docs, remap }) }),
  };

  window.claude = { use: async (n) => (n === "db" ? db : n === "user" ? user : null) };
  poll();
})();

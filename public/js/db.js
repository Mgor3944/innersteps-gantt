/* Data and sign-in layer for the Gantt.

   The chart was first built as a Claude artifact and talks to a small document database:
     db.collection(name).onSnapshot(cb, fail)      live list of documents
     db.doc("collection/id").onSnapshot(cb, fail)  one live document
     db.doc("collection/id").set(data) / .delete()
   This file gives it the same thing, backed by the "InnerSteps Gantt" Supabase project
   (one table, `docs`, with a row per document). Nothing here ever talks to any other project.

   Sign-in: each person has a personal link, https://gantt.innersteps.org/#k=<id>.<code>.
   Opening it once signs that browser in and keeps it signed in. */
(() => {
  const SUPABASE_URL = "https://kgyfowmlfovofcdepfyj.supabase.co";
  const SUPABASE_KEY = "sb_publishable_ZBZ97DYhtGCGgKgq2xT0UQ_5un1mU-9"; /* publishable key: safe to ship, the database rules do the protecting */
  const LOGIN_DOMAIN = "gantt.innersteps.org";
  const KEY_STORE = "gantt:key";
  const CLIENT = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const split = path => { const i = path.indexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; };
  const ls = { get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }, set(k, v){ try { localStorage.setItem(k, v); } catch(e){} }, del(k){ try { localStorage.removeItem(k); } catch(e){} } };

  let sb = null, me = null;
  const cache = new Map();          /* collection -> Map(id -> data) */
  const colSubs = new Map();        /* collection -> Set(callback) */
  const docSubs = new Map();        /* "collection/id" -> Set(callback) */
  const failSubs = new Set();
  const lastSeq = new Map();        /* path -> number of this browser's latest write to it */
  const pending = new Map();        /* path -> the next write waiting to be sent */
  const inflight = new Set();       /* paths with a write on its way */
  let seq = 0, ready = false, lastSync = 0, wasLive = false;

  const col = c => { let m = cache.get(c); if (!m){ m = new Map(); cache.set(c, m); } return m; };
  const colSnap = c => ({ docs: [...col(c)].map(([id, data]) => ({ id, exists: true, data: () => clone(data) })) });
  const docSnap = (c, id) => { const has = col(c).has(id), data = col(c).get(id); return { id, exists: has, data: () => clone(data) }; };
  function emit(c){
    if (!ready) return;
    for (const cb of colSubs.get(c) || []) try { cb(colSnap(c)); } catch(e){ console.error(e); }
    for (const [path, set] of docSubs){ const [dc, id] = split(path); if (dc === c) for (const cb of set) try { cb(docSnap(c, id)); } catch(e){ console.error(e); } }
  }
  const fail = err => { for (const cb of failSubs) try { cb(err); } catch(e){} };
  const busy = path => pending.has(path) || inflight.has(path);

  /* ---------- reading ---------- */
  async function loadAll(){
    const { data, error } = await sb.from("docs").select("collection,id,data");
    if (error) throw error;
    const next = new Map();
    for (const r of data){ if (!next.has(r.collection)) next.set(r.collection, new Map()); next.get(r.collection).set(r.id, r.data); }
    const changed = new Set();
    for (const c of new Set([...cache.keys(), ...next.keys()])){
      const old = col(c), neu = next.get(c) || new Map();
      /* a change this browser hasn't finished saving wins over what was just read */
      for (const [id, d] of old) if (busy(c + "/" + id)) neu.set(id, d);
      for (const path of [...pending.keys(), ...inflight]){ const [pc, id] = split(path); if (pc === c && !old.has(id)) neu.delete(id); }
      if (!same([...old], [...neu])) changed.add(c);
      cache.set(c, neu);
    }
    lastSync = Date.now();
    return changed;
  }
  async function resync(){ try { const ch = await loadAll(); for (const c of ch) emit(c); } catch(e){ /* stays on what it has; the next resync tries again */ } }

  function onChange(p){
    const row = p.eventType === "DELETE" ? p.old : p.new;
    if (!row || !row.collection || row.id == null) return;
    const path = row.collection + "/" + row.id, m = col(row.collection);
    if (p.eventType === "DELETE"){
      if (busy(path) || !m.has(row.id)) return;
      m.delete(row.id);
    } else {
      /* an echo of this browser's own older write: a newer one is already on screen */
      if (row.w_client === CLIENT && (row.w_seq || 0) < (lastSeq.get(path) || 0)) return;
      if (m.has(row.id) && same(m.get(row.id), row.data)) return;
      m.set(row.id, row.data);
    }
    emit(row.collection);
  }
  function goLive(){
    sb.channel("docs").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, onChange).subscribe(status => {
      if (status === "SUBSCRIBED"){ if (wasLive) resync(); wasLive = true; }
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastSync > 60000) resync(); });
    window.addEventListener("online", resync);
  }

  /* ---------- writing ---------- */
  function codeOf(error){
    const s = String((error && (error.code || error.status)) || ""), msg = String((error && error.message) || "");
    if (s === "42501" || s === "401" || s === "403" || /row-level security|permission denied|JWT/i.test(msg)) return "not_granted";
    return "failed";
  }
  async function send(path, body, n){
    const [c, id] = split(path);
    const q = body === null ? sb.from("docs").delete().eq("collection", c).eq("id", id)
      : sb.from("docs").upsert({ collection: c, id, data: body, w_client: CLIENT, w_seq: n }, { onConflict: "collection,id" });
    const { error } = await q;
    if (error) throw Object.assign(new Error(error.message || "Save failed"), { code: codeOf(error) });
  }
  async function pump(path){
    if (inflight.has(path)) return;
    const job = pending.get(path); if (!job) return;
    pending.delete(path); inflight.add(path);
    let err = null;
    try { await send(path, job.body, job.seq); } catch(e){ err = e; }
    inflight.delete(path);
    for (const [res, rej] of job.waiters) err ? rej(err) : res();
    if (pending.has(path)) pump(path);
    else if (err) resync(); /* put back whatever is really saved */
  }
  function write(path, body){
    const [c, id] = split(path), n = ++seq;
    lastSeq.set(path, n);
    if (body === null) col(c).delete(id); else col(c).set(id, clone(body));
    return new Promise((res, rej) => {
      const job = pending.get(path);
      if (job){ job.body = clone(body); job.seq = n; job.waiters.push([res, rej]); }
      else pending.set(path, { body: clone(body), seq: n, waiters: [[res, rej]] });
      pump(path);
    });
  }
  window.addEventListener("beforeunload", ev => { if (pending.size || inflight.size){ ev.preventDefault(); ev.returnValue = ""; } });

  const later = fn => Promise.resolve().then(fn);
  const db = {
    collection(c){
      return { onSnapshot(cb, onFail){
        if (!colSubs.has(c)) colSubs.set(c, new Set());
        colSubs.get(c).add(cb); if (onFail) failSubs.add(onFail);
        later(() => { if (ready && colSubs.get(c).has(cb)) cb(colSnap(c)); });
        return () => colSubs.get(c).delete(cb);
      } };
    },
    doc(path){
      const [c, id] = split(path);
      return {
        set: body => write(path, body),
        delete: () => write(path, null),
        onSnapshot(cb, onFail){
          if (!docSubs.has(path)) docSubs.set(path, new Set());
          docSubs.get(path).add(cb); if (onFail) failSubs.add(onFail);
          later(() => { if (ready && docSubs.get(path).has(cb)) cb(docSnap(c, id)); });
          return () => docSubs.get(path).delete(cb);
        }
      };
    }
  };

  /* ---------- sign-in ---------- */
  function parseKey(text){
    const m = /(?:#|^|[?&\s])k=([a-z0-9_-]+)\.([A-Za-z0-9_-]{16,})/.exec(String(text || "").trim()) || /^([a-z0-9_-]+)\.([A-Za-z0-9_-]{16,})$/.exec(String(text || "").trim());
    return m ? { id: m[1], code: m[2] } : null;
  }
  async function signInWithKey(k){
    const { error } = await sb.auth.signInWithPassword({ email: k.id + "@" + LOGIN_DOMAIN, password: k.code });
    if (error) return false;
    ls.set(KEY_STORE, k.id + "." + k.code);
    return true;
  }
  async function whoAmI(){
    const { data: s } = await sb.auth.getSession();
    if (!s || !s.session) return null;
    const { data, error } = await sb.from("people").select("id,name,admin").eq("user_id", s.session.user.id).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  function gate(message){
    return new Promise(resolve => {
      const el = document.createElement("div");
      el.className = "signin"; el.id = "signin";
      el.innerHTML = `<div class="si-top"><img src="/img/logo.svg" alt="InnerSteps"><span>InnerSteps Gantt Chart Software</span></div>
        <form class="si-form">
          <h2>Sign In</h2>
          <p class="si-copy">Opening your personal link signs you in automatically. If you're seeing this screen, paste it below. You only do this once per device.</p>
          <input class="in" id="signinKey" placeholder="Paste your sign-in link" autocomplete="off" spellcheck="false" aria-label="Your sign-in link">
          <button class="btn primary" type="submit">Sign In</button>
          <p class="si-msg" id="signinMsg" role="status"></p>
        </form>`;
      el.querySelector("#signinMsg").textContent = message || "";
      document.body.appendChild(el);
      const input = el.querySelector("#signinKey"), msg = el.querySelector("#signinMsg");
      input.focus();
      el.querySelector("form").addEventListener("submit", async ev => {
        ev.preventDefault();
        const k = parseKey(input.value);
        if (!k){ msg.textContent = "That doesn't look like a sign-in link. Paste the whole link you were sent."; return; }
        msg.textContent = "Signing in…";
        if (!(await signInWithKey(k))){ msg.textContent = "That link didn't work. Ask Jesse or Matt for a new one."; return; }
        el.remove(); resolve();
      });
    });
  }
  function accountMenu(){
    const menu = document.querySelector("#morewrap .menu"); if (!menu || !me) return;
    const sep = document.createElement("i"); sep.className = "msep";
    const who = document.createElement("div");
    who.style.cssText = "padding:6px 10px 2px;font-size:12px;color:var(--muted);white-space:nowrap";
    who.textContent = "Signed in as " + me.name;
    const out = document.createElement("button");
    out.setAttribute("role", "menuitem");
    out.innerHTML = `<span class="ms">logout</span>Sign Out`;
    out.addEventListener("click", async () => { ls.del(KEY_STORE); try { await sb.auth.signOut(); } catch(e){} location.reload(); });
    if (me.admin){
      const team = document.createElement("button");
      team.setAttribute("role", "menuitem");
      team.innerHTML = `<span class="ms">group</span>Team Access`;
      team.addEventListener("click", teamAccess);
      menu.append(sep, team, who, out);
    } else menu.append(sep, who, out);
  }

  /* Team Access (Jesse and Matt only): remove someone, or give them back access. The database checks who is asking. */
  async function teamAccess(){
    const wrap = document.createElement("div");
    wrap.className = "scrim"; wrap.style.zIndex = "60";
    wrap.innerHTML = `<div class="modal" role="dialog" aria-label="Team Access" style="width:min(440px,100%)">
      <h2>Team Access</h2>
      <p class="hint">Removing someone signs them out straight away. Their tasks stay on the plan, and you can give them access again any time.</p>
      <div class="ta-list" style="display:flex;flex-direction:column;gap:6px"><p class="hint">Loading…</p></div>
      <p class="hint ta-msg" style="color:var(--late-ink);min-height:1.2em;margin:0"></p>
      <div style="display:flex;justify-content:flex-end"><button class="btn" data-close>Done</button></div>
    </div>`;
    document.body.appendChild(wrap);
    const close = () => { wrap.remove(); document.removeEventListener("keydown", esc); };
    const esc = ev => { if (ev.key === "Escape") close(); };
    document.addEventListener("keydown", esc);
    wrap.addEventListener("click", ev => { if (ev.target === wrap || ev.target.closest("[data-close]")) close(); });
    const list = wrap.querySelector(".ta-list"), msg = wrap.querySelector(".ta-msg");
    async function load(){
      const { data, error } = await sb.from("people").select("id,name,active,admin").order("name");
      if (error){ list.innerHTML = `<p class="hint">Couldn't load the team. Check your connection and try again.</p>`; return; }
      list.innerHTML = "";
      for (const p of data){
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--bg)";
        const name = document.createElement("span");
        name.style.cssText = "flex:1;font-weight:600;" + (p.active ? "" : "color:var(--muted);text-decoration:line-through");
        name.textContent = p.name + (p.id === me.id ? " (You)" : "");
        row.append(name);
        if (p.id !== me.id){
          const b = document.createElement("button");
          b.className = "btn" + (p.active ? " danger" : "");
          b.style.height = "32px";
          b.textContent = p.active ? "Remove" : "Give Access Back";
          b.addEventListener("click", async () => {
            if (p.active && !b.classList.contains("confirm")){ b.classList.add("confirm"); b.textContent = "Remove " + p.name + "?"; return; }
            b.disabled = true; msg.textContent = "";
            const { error: e } = await sb.rpc("set_member_active", { p_id: p.id, p_active: !p.active });
            if (e){ msg.textContent = "Couldn't change that. " + (e.message || ""); b.disabled = false; return; }
            load();
          });
          row.append(b);
        }
        list.append(row);
      }
    }
    load();
  }

  async function connect(){
    if (!window.supabase || !window.supabase.createClient) return null;
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "gantt:session" } });
    /* a personal link in the address bar: use it, then tidy it out of the address */
    const fromUrl = parseKey(location.hash);
    if (fromUrl){ await signInWithKey(fromUrl); try { history.replaceState(null, "", location.pathname + location.search); } catch(e){} }
    let message = "";
    for (;;){
      try { me = await whoAmI(); } catch(e){ return null; }
      if (me) break;
      /* signed out for any reason: quietly use this device's saved link before asking again */
      const saved = parseKey(ls.get(KEY_STORE));
      if (saved && !message && await signInWithKey(saved)){ message = "This sign-in link no longer has access. Ask Jesse or Matt for a new one."; continue; }
      const { data: s } = await sb.auth.getSession();
      if (s && s.session){ try { await sb.auth.signOut(); } catch(e){} }
      await gate(message); message = "This sign-in link no longer has access. Ask Jesse or Matt for a new one.";
    }
    try { await loadAll(); } catch(e){ return null; }
    ready = true;
    goLive();
    sb.auth.onAuthStateChange(ev => { if (ev === "SIGNED_OUT") fail({ code: "revoked" }); });
    accountMenu();
    return db;
  }

  window.GanttDB = { connect, me: () => me };
})();

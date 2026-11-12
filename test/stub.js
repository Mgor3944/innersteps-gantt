/* test stand-in for the Supabase library */
(() => {
  const today = new Date().toISOString().slice(0,10), plus = n => new Date(Date.now()+n*864e5).toISOString().slice(0,10);
  const rows = [
    {collection:"categories", id:"c01", data:{name:"Story Pipeline", color:"violet", order:1, subs:[{id:"sep1", name:"Episode 1"}]}},
    {collection:"categories", id:"c14", data:{name:"Marketing", color:"pink", order:2}},
    {collection:"tasks", id:"t1", data:{cat:"c01", sub:"sep1", name:"E1 script", start:plus(-2), end:plus(3), status:"todo", owners:["Anna"], order:1}},
    {collection:"tasks", id:"t2", data:{cat:"c01", name:"E1 art", start:plus(4), end:plus(9), status:"todo", owners:["Dipesh"], deps:["t1"], order:2}},
    {collection:"tasks", id:"t3", data:{cat:"c14", name:"Launch email", start:plus(1), end:plus(2), status:"doing", owners:["Jesse"], order:1}},
    {collection:"away", id:"a1", data:{person:"Anna", start:plus(1), end:plus(2), note:"Holiday"}},
    {collection:"settings", id:"plan", data:{launch:plus(40), title:"S2"}},
    {collection:"notes", id:"summary", data:{text:"Hello", updated:1}},
    {collection:"changelog", id:"log28", data:{at:1, date:today, text:"x"}}
  ];
  window.__team = [{id:"jesse",name:"Jesse",ini:"JW",color:"violet",active:true,admin:true,sort:1},{id:"anna",name:"Anna",ini:"AN",color:"green",active:true,admin:false,sort:2},{id:"dipesh",name:"Dipesh",ini:"DS",color:"yellow",active:true,admin:false,sort:3}]; window.__rpc = [];
  window.__rows = rows; window.__writes = []; window.__session = null; window.__member = true; window.__delay = 30;
  const wait = v => new Promise(r => setTimeout(() => r(v), window.__delay));
  function from(table){
    const q = {op:"select", f:{}};
    const b = {
      select(){ return b; }, order(){ return b; }, eq(k, v){ q.f[k] = v; return b; },
      upsert(row){ q.op = "upsert"; q.row = row; return b; }, delete(){ q.op = "delete"; return b; },
      maybeSingle(){ q.single = true; return b; },
      then(res, rej){ return wait().then(() => {
        if (table === "people"){ if (!(window.__session && window.__member)) return {data:null, error:null}; if (q.single) return {data:{id:"jesse", name:"Jesse", admin:window.__admin !== false}, error:null}; return {data: window.__team, error:null}; }
        if (!window.__session || !window.__member) return q.op === "select" ? {data:[], error:null} : {data:null, error:{code:"42501", message:"new row violates row-level security policy"}};
        if (q.op === "select") return {data: rows.map(r => ({...r})), error:null};
        window.__writes.push(q.op === "upsert" ? {op:"upsert", ...q.row} : {op:"delete", ...q.f});
        if (q.op === "upsert"){ const i = rows.findIndex(r => r.collection === q.row.collection && r.id === q.row.id); const r = {collection:q.row.collection, id:q.row.id, data:q.row.data}; if (i < 0) rows.push(r); else rows[i] = r; window.__emit && setTimeout(() => window.__emit({eventType: i < 0 ? "INSERT" : "UPDATE", new:{...q.row}}), 40); }
        else { const i = rows.findIndex(r => r.collection === q.f.collection && r.id === q.f.id); if (i >= 0) rows.splice(i, 1); window.__emit && setTimeout(() => window.__emit({eventType:"DELETE", old:{collection:q.f.collection, id:q.f.id}}), 40); }
        return {data:null, error:null};
      }).then(res, rej); }
    };
    return b;
  }
  window.supabase = { createClient: () => ({
    auth: {
      async signInWithPassword({email, password}){ if (email === "jesse@gantt.innersteps.org" && password === "a".repeat(32)){ window.__session = {user:{id:"u1"}}; return {error:null}; } return {error:{message:"Invalid login credentials"}}; },
      async getSession(){ return {data:{session: window.__session}}; },
      async signOut(){ window.__session = null; return {}; },
      onAuthStateChange(){ return {data:{subscription:{unsubscribe(){}}}}; }
    },
    from,
    async rpc(fn, args){
      window.__rpc.push([fn, args]);
      if (fn === "set_member_active"){ const p = window.__team.find(x => x.id === args.p_id); if (p) p.active = args.p_active; return {error:null}; }
      if (fn === "admin_new_link") return {data:"n".repeat(32), error:null};
      if (fn === "admin_add_person"){ const id = args.p_name.toLowerCase(); window.__team.push({id, name:args.p_name, ini:args.p_ini, color:"indigo", active:true, admin:false, sort:9}); return {data:{id, code:"c".repeat(32)}, error:null}; }
      return {error:{message:"unknown"}};
    },
    channel(){ const c = { on(_t, _f, cb){ window.__emit = cb; return c; }, subscribe(cb){ setTimeout(() => cb("SUBSCRIBED"), 10); return c; } }; return c; }
  }) };
})();

import sys, json, http.server, threading, functools, os
from playwright.sync_api import sync_playwright
root=sys.argv[1]
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
h.log_message=lambda *a,**k: None
srv=http.server.ThreadingHTTPServer(("127.0.0.1",8765),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
stub=open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "stub.js")).read()
ok=True
def check(name, cond, extra=""):
    global ok; ok = ok and bool(cond); print(("PASS " if cond else "FAIL ")+name, extra)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    def page_for(url):
        ctx=b.new_context(viewport={"width":1400,"height":900}); pg=ctx.new_page()
        errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.route("**/vendor/supabase.js", lambda r: r.fulfill(body=stub, content_type="text/javascript"))
        pg.route("**fonts.g*", lambda r: r.abort())
        pg.goto(url); return pg, errs
    # 1. no link: sign-in screen, plan hidden
    pg,errs=page_for("http://127.0.0.1:8765/")
    pg.wait_for_selector("#signin"); check("sign-in screen shows without a link", True)
    check("no tasks rendered before sign-in", pg.locator(".row.task").count()==0)
    pg.fill("#signinKey","nonsense"); pg.click("#signin button[type=submit]"); pg.wait_for_timeout(100)
    check("rejects text that isn't a link", "doesn't look like" in pg.inner_text("#signinMsg"))
    pg.fill("#signinKey","https://gantt.innersteps.org/#k=jesse."+"b"*32); pg.click("#signin button[type=submit]"); pg.wait_for_timeout(300)
    check("rejects a wrong code", "didn't work" in pg.inner_text("#signinMsg"))
    pg.fill("#signinKey","https://gantt.innersteps.org/#k=jesse."+"a"*32); pg.click("#signin button[type=submit]")
    pg.wait_for_selector(".row.task[data-task]"); check("pasting a good link signs in and loads the plan", pg.locator("#signin").count()==0)
    check("no page errors (paste flow)", not errs, errs)
    # 2. link in the address bar
    pg,errs=page_for("http://127.0.0.1:8765/#k=jesse."+"a"*32)
    pg.wait_for_selector(".row.task[data-task]")
    check("link in address signs in", True); check("link removed from address", "#k=" not in pg.url, pg.url)
    n=pg.locator(".row.task[data-task]").count(); check("3 tasks shown", n==3, n)
    check("Team Away + 2 categories + 1 sub-category", pg.locator(".row.cat").count()==4, pg.locator(".row.cat").count())
    check("bars drawn", pg.locator(".bar").count()>=4, pg.locator(".bar").count())
    check("title from settings", pg.inner_text("#title")=="S2 Launch Plan", pg.inner_text("#title"))
    check("signed-in name in menu", "Signed in as Jesse" in pg.inner_html("#morewrap .menu"))
    # 2b. Team: renamed, admin-only Add Member row and member buttons
    check("category is called Team", pg.inner_text('.row.cat[data-cat="__away"] .cat-name')=="Team")
    check("chart team comes from the database", pg.evaluate("TEAM.map(p=>p.name).join(',')")=="Jesse,Anna,Dipesh", pg.evaluate("TEAM.map(p=>p.name).join(',')"))
    check("no Team Access in the menu any more", "Team Access" not in pg.inner_html('#morewrap .menu'))
    check("admin sees Add Member", pg.locator('[data-act="add-member"].tname').count()==1)
    pg.click('.awayrow[data-person="Anna"] .pbtn'); pg.wait_for_selector('#drawer.open [data-act="new-link"]')
    check("admin sees Remove Member and New Sign In Link", pg.locator('#drawer [data-act="remove-member"]').count()==1)
    pg.click('#drawer [data-act="new-link"]'); check("new link asks to confirm first", pg.evaluate("window.__rpc.length")==0)
    pg.click('#drawer [data-act="new-link"]'); pg.wait_for_selector('#drawer .linkbox input')
    check("new link shown in the panel", pg.input_value('#drawer .linkbox input').endswith("/#k=anna."+"n"*32))
    pg.click('#drawer [data-act="remove-member"]'); check("remove asks to confirm first", pg.evaluate("window.__rpc.length")==1 and "Remove Anna?" in pg.inner_text('#drawer [data-act="remove-member"]'))
    pg.click('#drawer [data-act="remove-member"]'); pg.wait_for_timeout(300)
    check("removed: drawer closes, row gone, name kept on tasks", not pg.evaluate("document.getElementById('drawer').classList.contains('open')") and pg.locator('.awayrow[data-person="Anna"]').count()==0 and "Anna" in pg.evaluate("TEAM_NAMES"))
    pg.click('.awayrow[data-person="Jesse"] .pbtn'); pg.wait_for_selector('#drawer.open [data-act="new-link"]')
    check("can't remove yourself", pg.locator('#drawer [data-act="remove-member"]').count()==0)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    pg.click('[data-act="add-member"].tname'); pg.wait_for_selector('#memberForm')
    pg.fill('#mName','milo'); check("initials fill in from the name", pg.input_value('#mIni')=="MI")
    pg.click('#memberForm [data-role="admin"]'); pg.click('#memberForm [type=submit]'); pg.wait_for_selector('#memberForm .linkbox input')
    check("new member: Admin role sent, name title-cased, link shown", pg.evaluate("JSON.stringify(window.__rpc.at(-1))")=='["admin_add_person",{"p_name":"Milo","p_ini":"MI","p_admin":true}]' and pg.input_value('#memberForm .linkbox input').endswith("/#k=milo."+"c"*32), pg.evaluate("JSON.stringify(window.__rpc.at(-1))"))
    pg.click('#memberForm [data-act="modal-close"]'); pg.wait_for_timeout(200)
    check("new member gets a Team row", pg.locator('.awayrow[data-person="Milo"]').count()==1)
    pg.click('[data-act="add-member"].tname'); pg.fill('#mName','Anna'); pg.click('#memberForm [type=submit]'); pg.wait_for_selector('#memberForm .linkbox')
    check("adding a removed person's name brings them back", "Anna Is Back" in pg.inner_text('#memberForm') and pg.locator('.awayrow[data-person="Anna"]').count()==1)
    pg.click('#memberForm [data-act="modal-close"]')
    pg.evaluate("window.__admin=false")
    # 3. a status click saves once, to the right document, and survives its own echo
    pg.click('.row.task[data-task="t1"] .status'); pg.wait_for_timeout(300)
    w=pg.evaluate("window.__writes"); check("status click saved", len(w)==1 and w[0]["collection"]=="tasks" and w[0]["id"]=="t1" and w[0]["data"]["status"]=="doing", json.dumps(w)[:200])
    check("row shows In Progress", "doing" in pg.get_attribute('.row.task[data-task="t1"] .status',"class"))
    # 4. fast repeat edits to one task: kept in order, never fall back to an older value
    pg.evaluate("window.__writes.length=0; window.__delay=150")
    pg.click('.row.task[data-task="t1"] .status'); pg.click('.row.task[data-task="t1"] .status'); pg.click('.row.task[data-task="t1"] .status')
    seen=[]
    for i in range(12):
        seen.append(pg.evaluate("S.tasks.get('t1').status")); pg.wait_for_timeout(80)
    w=pg.evaluate("window.__writes.map(x=>x.data.status)")
    check("screen never falls back during saves", set(seen)=={"doing"}, seen)
    check("last save is the latest value", w and w[-1]=="doing", w)
    check("saved copy matches", pg.evaluate("window.__rows.find(r=>r.id==='t1').data.status")=="doing")
    # 5. a teammate's change arrives live
    pg.evaluate("window.__delay=30; window.__emit({eventType:'UPDATE', new:{collection:'tasks', id:'t3', data:{cat:'c14', name:'Launch email v2', start:'2026-11-20', end:'2026-11-21', status:'done', owners:['Jesse'], order:1}, w_client:'other', w_seq:1}})")
    pg.wait_for_timeout(100); check("teammate's edit shows up", "Launch Email V2" in pg.inner_text('.row.task[data-task="t3"] .tname'), pg.inner_text('.row.task[data-task="t3"] .tname'))
    pg.evaluate("window.__emit({eventType:'DELETE', old:{collection:'tasks', id:'t3'}})"); pg.wait_for_timeout(100)
    check("teammate's delete shows up", pg.locator('.row.task[data-task="t3"]').count()==0)
    # 6. delete then undo
    pg.evaluate("window.__writes.length=0; removeTaskTest = () => act('Delete', () => removeTask('t2')); removeTaskTest()"); pg.wait_for_timeout(200)
    check("delete saved", pg.evaluate("window.__writes.some(w=>w.op==='delete'&&w.id==='t2')"))
    pg.evaluate("undo()"); pg.wait_for_timeout(300)
    check("undo brings the task back, saved", pg.evaluate("S.tasks.has('t2') && window.__rows.some(r=>r.id==='t2')"))
    # 7. stays signed in on reload (saved link), sign out works
    pg.evaluate("window.__session=null"); pg.reload(); 
    pg.wait_for_selector(".row.task[data-task]"); check("reload signs back in from the saved link", pg.locator("#signin").count()==0)
    # 8. access removed: read-only message path
    pg.evaluate("window.__member=false; window.__writes.length=0"); pg.click('.row.task[data-task="t1"] .status'); pg.wait_for_timeout(400)
    check("refused save turns the page read-only", pg.evaluate("document.body.classList.contains('readonly')"))
    check("no page errors", not errs, errs)
    pass
    b.close()
print("ALL OK" if ok else "SOME FAILED")

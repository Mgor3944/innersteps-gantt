# InnerSteps Gantt

The Series 2 Launch Plan, an interactive Gantt chart used for the whole team's product management.
Live at `https://gantt.innersteps.org` (Cloudflare Worker `innersteps-gantt`, deployed from `main`).
It began as a Claude artifact; this repo is now the source of truth.

## Hard rules
- The data lives in the Supabase project **InnerSteps Gantt** (ref `kgyfowmlfovofcdepfyj`, Sydney). Only ever touch that project.
  Never read, change or connect to **InnerSteps Backend** (`miqudsshtzxjpdcmtmzl`), the live app's database.
- Only touch the Cloudflare Worker named `innersteps-gantt`. Leave every other Cloudflare resource alone.
- Never put a Supabase secret key in this repo or in the page. The page only uses the publishable key.
- No em dashes in anything the team reads.

## How it's built
- `public/index.html`: the whole chart (plain HTML, CSS and JavaScript, no framework, no build step).
- `public/js/db.js`: sign-in and data. It gives the chart the small document API it was written against
  (`db.collection(c).onSnapshot`, `db.doc("c/id").set/delete/onSnapshot`) on top of Supabase.
- `public/vendor/supabase.js`: the Supabase browser library (supabase-js 2.119.0), vendored so nothing loads from a CDN.
- `supabase/migrations/`: the database setup, kept here as the record. Add a new numbered file for every change.
- `wrangler.jsonc`: static assets only. There is no Worker code.

## Data model
One table, `public.docs (collection, id, data jsonb)`, a row per document. Collections: `categories`, `tasks`,
`away`, `changelog`, `notes` (`summary`), `settings` (`plan`). The shape of each document is whatever the chart writes.
- `updated_by` / `updated_at` are stamped by a trigger from the signed-in person.
- `public.changes` records every insert, update and delete with who made it and the before/after. The page never writes it.
- `public.people` is the team: only people listed there (and `active`) can read or write anything. Row Level Security enforces this.
- Live updates use Supabase Realtime on `docs`.
- `db.js` reads all of `docs` in one request. The API returns at most 1,000 rows per request, so page it if the plan ever gets near that.

## Saving
The chart updates its own state first, then calls `enqueue(path, fn)`, which hands the write to `db.js` at once.
`db.js` keeps one write per document in flight, merges fast repeat edits into the latest value, and ignores echoes of its own older writes,
so the screen never falls back to an older value. If a save fails it re-reads what is really saved.

## Sign-in
No passwords to remember. Each person has a personal link, `https://gantt.innersteps.org/#k=<id>.<code>`.
Opening it once signs that browser in and it stays signed in. Behind it is a Supabase Auth user `<id>@gantt.innersteps.org`
whose password is the code. To add someone or replace a lost or leaked link, run in the SQL editor of the Gantt project:
`select private.add_person('<id>', '<Name>');` and send them the link with the code it returns. `<Name>` must match the name in `TEAM` in `index.html`.
Jesse and Matt (`people.admin`) can remove someone, or give them access back, from **Team Access** in the chart's menu
(`public.set_member_active(id, active)`, which checks the caller is an admin, refuses to remove yourself and signs the removed person out).

The sign-in screen (`gate()` in `db.js`, `.signin` / `.si-*` styles in `index.html`) is white to the window's edges, split in two: `public/img/signin.webp` fills the left box, pinned to its top left.
That file is public, so anything in the picture can be seen by anyone who opens the site without signing in.

## Testing
`npm test` (needs Python Playwright and Chrome) runs the chart against a stand-in database (`test/stub.js`) and checks sign-in,
loading, saving order, live updates, undo and the read-only path. Run it before every push to `main`.

## Local dev
`npx wrangler dev`, then open your personal link with the host swapped for `http://localhost:8787`.

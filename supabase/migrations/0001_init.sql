-- InnerSteps Gantt: database setup (Supabase project "InnerSteps Gantt", ref kgyfowmlfovofcdepfyj).
-- This project is separate from "InnerSteps Backend" and must stay that way.

create schema if not exists private;

-- The team: who may sign in. `name` matches the name used on tasks in the chart.
create table public.people (
  id text primary key,
  name text not null,
  user_id uuid unique references auth.users (id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Everything the chart stores, one row per document.
-- collection is one of: categories, tasks, away, changelog, notes, settings.
create table public.docs (
  collection text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text,
  w_client text,
  w_seq bigint,
  primary key (collection, id)
);

-- Who changed what, and when. Written by a trigger, never by the page.
create table public.changes (
  n bigint generated always as identity primary key,
  at timestamptz not null default now(),
  by text,
  collection text not null,
  id text not null,
  op text not null,
  before jsonb,
  after jsonb
);
create index changes_doc on public.changes (collection, id, n desc);

-- Is the signed-in user an active team member?
create function private.is_member() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.people p where p.user_id = (select auth.uid()) and p.active) $$;

create function private.member_name() returns text
language sql stable security definer set search_path = ''
as $$ select p.name from public.people p where p.user_id = (select auth.uid()) and p.active $$;

-- Stamp each save with the person and time, and keep a record of the change.
create function private.docs_stamp() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := private.member_name();
  return new;
end $$;

create function private.docs_log() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.changes (by, collection, id, op, before) values (private.member_name(), old.collection, old.id, 'delete', old.data);
    return old;
  elsif tg_op = 'INSERT' then
    insert into public.changes (by, collection, id, op, after) values (new.updated_by, new.collection, new.id, 'insert', new.data);
  elsif new.data is distinct from old.data then
    insert into public.changes (by, collection, id, op, before, after) values (new.updated_by, new.collection, new.id, 'update', old.data, new.data);
  end if;
  return new;
end $$;

create trigger docs_stamp before insert or update on public.docs for each row execute function private.docs_stamp();
create trigger docs_log after insert or update or delete on public.docs for each row execute function private.docs_log();

-- Access: nothing for visitors who aren't signed in; signed-in team members can read and edit the plan.
alter table public.people enable row level security;
alter table public.docs enable row level security;
alter table public.changes enable row level security;

revoke all on public.people, public.docs, public.changes from anon, authenticated;
grant select on public.people, public.changes to authenticated;
grant select, insert, update, delete on public.docs to authenticated;
grant usage on schema private to authenticated;
revoke all on all functions in schema private from public, anon;
grant execute on function private.is_member() to authenticated;

create policy "team reads people" on public.people for select to authenticated using ((select private.is_member()));
create policy "team reads changes" on public.changes for select to authenticated using ((select private.is_member()));
create policy "team reads docs" on public.docs for select to authenticated using ((select private.is_member()));
create policy "team adds docs" on public.docs for insert to authenticated with check ((select private.is_member()));
create policy "team edits docs" on public.docs for update to authenticated using ((select private.is_member())) with check ((select private.is_member()));
create policy "team deletes docs" on public.docs for delete to authenticated using ((select private.is_member()));

-- Live updates: everyone sees changes as they happen.
alter publication supabase_realtime add table public.docs;

-- Adds a team member (or gives an existing one a fresh sign-in link) and returns the code for their link:
--   select private.add_person('jesse', 'Jesse');   ->  https://gantt.innersteps.org/#k=jesse.<code>
-- Run from the SQL editor only; the page can't call it.
create function private.add_person(p_id text, p_name text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := p_id || '@gantt.innersteps.org';
  v_code text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
  v_uid uuid;
begin
  select id into v_uid from auth.users where email = v_email;
  if v_uid is null then
    v_uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email,
      extensions.crypt(v_code, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', jsonb_build_object('name', p_name), now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_uid, v_uid::text,
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());
  else
    update auth.users set encrypted_password = extensions.crypt(v_code, extensions.gen_salt('bf')), updated_at = now() where id = v_uid;
    delete from auth.sessions where user_id = v_uid;
  end if;
  insert into public.people (id, name, user_id) values (p_id, p_name, v_uid)
    on conflict (id) do update set name = excluded.name, user_id = excluded.user_id, active = true;
  return v_code;
end $$;
revoke all on function private.add_person(text, text) from public, anon, authenticated;

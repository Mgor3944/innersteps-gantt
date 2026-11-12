-- Jesse and Matt can remove team members (and give access back) from Team Access in the chart's menu.
alter table public.people add column if not exists admin boolean not null default false;
update public.people set admin = true where id in ('jesse','matt');

create function private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.people p where p.user_id = (select auth.uid()) and p.active and p.admin) $$;

-- Removing also signs them out everywhere. Admins can't remove themselves.
create function public.set_member_active(p_id text, p_active boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid; v_me uuid := (select auth.uid());
begin
  if not private.is_admin() then raise exception 'Only Jesse and Matt can change who has access' using errcode = '42501'; end if;
  select user_id into v_uid from public.people where id = p_id;
  if not found then raise exception 'No such team member' using errcode = 'P0002'; end if;
  if v_uid = v_me and not p_active then raise exception 'You can''t remove yourself' using errcode = '42501'; end if;
  update public.people set active = p_active where id = p_id;
  if not p_active and v_uid is not null then delete from auth.sessions where user_id = v_uid; end if;
end $$;
revoke all on function public.set_member_active(text, boolean) from public, anon;
grant execute on function public.set_member_active(text, boolean) to authenticated;
grant execute on function private.is_admin() to authenticated;

-- Admins see everyone, including removed people; everyone else only sees active members
drop policy "team reads people" on public.people;
create policy "team reads people" on public.people for select to authenticated
  using ((select private.is_member()) and (active or (select private.is_admin())));

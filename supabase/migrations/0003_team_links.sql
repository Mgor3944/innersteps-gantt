-- Team Access, part 2: Jesse and Matt can make a new sign-in link for anyone, and add new team members.
-- The chart now reads its team (name, initials, colour) from public.people instead of a list in the page.

alter table public.people add column if not exists ini text;
alter table public.people add column if not exists color text;
update public.people p set ini = v.ini, color = v.color
from (values ('matt','MG','blue'),('jesse','JW','violet'),('jay','JP','teal'),('anissa','AM','pink'),
             ('anna','AN','green'),('dipesh','DS','yellow'),('sofia','SP','slate')) as v(id, ini, color)
where p.id = v.id and p.ini is null;
alter table public.people add column if not exists sort int;
update public.people p set sort = v.n
from (values ('matt',1),('jesse',2),('jay',3),('anissa',4),('anna',5),('dipesh',6),('sofia',7)) as v(id, n)
where p.id = v.id and p.sort is null;

-- Everyone on the team can see the whole team, including people who were removed, so their old tasks keep their name.
drop policy "team reads people" on public.people;
create policy "team reads people" on public.people for select to authenticated using ((select private.is_member()));

-- A fresh sign-in link for someone who has access. Their old link stops working and they're signed out everywhere.
create function public.admin_new_link(p_id text) returns text
language plpgsql security definer set search_path = ''
as $$
declare v_name text; v_active boolean;
begin
  if not private.is_admin() then raise exception 'Only Jesse and Matt can make sign-in links' using errcode = '42501'; end if;
  select name, active into v_name, v_active from public.people where id = p_id;
  if v_name is null then raise exception 'No such team member' using errcode = 'P0002'; end if;
  if not v_active then raise exception 'Give them access back first' using errcode = '42501'; end if;
  return private.add_person(p_id, v_name);
end $$;

-- Adds a new team member and returns their id and sign-in code. Their colour is the first one nobody else uses.
create function public.admin_add_person(p_name text, p_ini text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_ini text := upper(left(regexp_replace(coalesce(p_ini, ''), '[^A-Za-z]', '', 'g'), 2));
  v_base text; v_id text; v_n int := 1; v_code text; v_color text; v_taken text[];
begin
  if not private.is_admin() then raise exception 'Only Jesse and Matt can add team members' using errcode = '42501'; end if;
  if v_name = '' or length(v_name) > 40 then raise exception 'Give them a name' using errcode = '22023'; end if;
  if exists (select 1 from public.people where lower(name) = lower(v_name)) then
    raise exception 'Someone called % is already on the team', v_name using errcode = '23505';
  end if;
  if v_ini = '' then v_ini := upper(left(regexp_replace(v_name, '[^A-Za-z]', '', 'g'), 2)); end if;
  v_base := coalesce(nullif(regexp_replace(lower(v_name), '[^a-z0-9]', '', 'g'), ''), 'person');
  v_id := v_base;
  while exists (select 1 from public.people where id = v_id) loop v_n := v_n + 1; v_id := v_base || v_n; end loop;
  select array_agg(c) into v_taken from (
    select color as c from public.people
    union select value from public.docs, jsonb_each_text(data->'personColors') where collection = 'settings' and id = 'plan'
  ) t;
  select c into v_color from unnest(array['yellow','tan','slate','olive','lime','sage','green','mint','teal','cyan','blue','indigo','violet','pink']) with ordinality u(c, o)
    where not (c = any(coalesce(v_taken, '{}'))) order by o limit 1;
  v_code := private.add_person(v_id, v_name);
  update public.people set ini = v_ini, color = coalesce(v_color, 'slate'), sort = (select coalesce(max(sort), 0) + 1 from public.people) where id = v_id;
  return jsonb_build_object('id', v_id, 'code', v_code);
end $$;

revoke all on function public.admin_new_link(text) from public, anon;
revoke all on function public.admin_add_person(text, text) from public, anon;
grant execute on function public.admin_new_link(text) to authenticated;
grant execute on function public.admin_add_person(text, text) to authenticated;

-- Add Member (in the chart's Team rows) sets a role, Admin or Member. Adding the name of someone who was removed
-- brings them back with a new link, keeping their name, colour and tasks. Replaces admin_add_person(text, text).
drop function public.admin_add_person(text, text);

create function public.admin_add_person(p_name text, p_ini text, p_admin boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_ini text := upper(left(regexp_replace(coalesce(p_ini, ''), '[^A-Za-z]', '', 'g'), 2));
  v_old public.people; v_base text; v_id text; v_n int := 1; v_code text; v_color text; v_taken text[];
begin
  if not private.is_admin() then raise exception 'Only Jesse and Matt can add team members' using errcode = '42501'; end if;
  if v_name = '' or length(v_name) > 40 then raise exception 'Give them a name' using errcode = '22023'; end if;
  if v_ini = '' then v_ini := upper(left(regexp_replace(v_name, '[^A-Za-z]', '', 'g'), 2)); end if;
  select * into v_old from public.people where lower(name) = lower(v_name);
  if found then
    if v_old.active then raise exception '% is already on the team', v_old.name using errcode = '23505'; end if;
    -- someone who was removed: bring them back with a new link, keeping their name, colour and tasks
    v_code := private.add_person(v_old.id, v_old.name);
    update public.people set ini = v_ini, admin = coalesce(p_admin, false) where id = v_old.id;
    return jsonb_build_object('id', v_old.id, 'code', v_code, 'restored', true);
  end if;
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
  update public.people set ini = v_ini, color = coalesce(v_color, 'slate'), admin = coalesce(p_admin, false),
    sort = (select coalesce(max(sort), 0) + 1 from public.people) where id = v_id;
  return jsonb_build_object('id', v_id, 'code', v_code, 'restored', false);
end $$;
revoke all on function public.admin_add_person(text, text, boolean) from public, anon;
grant execute on function public.admin_add_person(text, text, boolean) to authenticated;

-- 0003: RPC functions for everything the browser may not write directly.
-- All are SECURITY DEFINER with an empty search_path, executable by signed-in users only.
-- Failed guesses return NULL instead of raising, so the throttle record is kept (a raised error would roll it back).

create function public.my_profile() returns table (id uuid, username text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username::text from public.profiles p where p.auth_user_id = auth.uid()
$$;

-- Create your profile, or claim a legacy one with its one-time code. NULL = taken / wrong code.
create function public.register_profile(p_username text, p_claim_code text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
  v_code text := upper(regexp_replace(coalesce(p_claim_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_old  public.profiles;
  v_id   uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  if exists (select 1 from public.profiles where auth_user_id = auth.uid()) then raise exception 'You already have a profile.'; end if;
  if v_name !~ '^[A-Za-z0-9][A-Za-z0-9 ''.\-]{0,29}$' then
    raise exception 'Usernames can use letters, numbers, spaces and - . '' (30 max).';
  end if;
  perform private.throttle('register', 10, interval '15 minutes');

  select * into v_old from public.profiles where username = v_name::extensions.citext;
  if found then
    if v_old.auth_user_id is null and v_old.claim_hash is not null and v_code <> ''
       and v_old.claim_hash = encode(extensions.digest(v_code, 'sha256'), 'hex') then
      update public.profiles set auth_user_id = auth.uid(), claim_hash = null where id = v_old.id;
      return v_old.id;
    end if;
    return null;
  end if;
  begin
    insert into public.profiles (auth_user_id, username) values (auth.uid(), v_name::extensions.citext) returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end $$;

create function public.change_username(p_username text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_name text := btrim(coalesce(p_username, ''));
begin
  if private.me() is null then raise exception 'Finish setting up your profile first.'; end if;
  if v_name !~ '^[A-Za-z0-9][A-Za-z0-9 ''.\-]{0,29}$' then
    raise exception 'Usernames can use letters, numbers, spaces and - . '' (30 max).';
  end if;
  perform private.throttle('rename', 5, interval '1 hour');
  begin
    update public.profiles set username = v_name::extensions.citext where id = private.me();
  exception when unique_violation then
    raise exception 'That username is taken.';
  end;
end $$;

create function public.create_group(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.me(); v_name text := btrim(coalesce(p_name, ''));
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_code text; v_b bytea; v_id uuid; i int;
begin
  if v_me is null then raise exception 'Finish setting up your profile first.'; end if;
  if char_length(v_name) not between 1 and 40 then raise exception 'Group names need 1 to 40 characters.'; end if;
  perform private.throttle('group', 10, interval '1 hour');
  if (select count(*) from public.groups where created_by = v_me) >= 20 then raise exception 'You have reached the group limit.'; end if;
  loop
    v_code := ''; v_b := extensions.gen_random_bytes(8);
    for i in 0..7 loop v_code := v_code || substr(v_alpha, (get_byte(v_b, i) % 32) + 1, 1); end loop;
    exit when not exists (select 1 from public.groups where invite_code = v_code);
  end loop;
  insert into public.groups (name, invite_code, created_by) values (v_name, v_code, v_me) returning id into v_id;
  insert into public.group_members (group_id, profile_id, role) values (v_id, v_me, 'owner');
  return v_id;
end $$;

-- NULL = no group with that code.
create function public.join_group(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me(); v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); v_g uuid;
begin
  if v_me is null then raise exception 'Finish setting up your profile first.'; end if;
  perform private.throttle('join', 10, interval '15 minutes');
  select id into v_g from public.groups where invite_code = v_code;
  if v_g is null then return null; end if;
  if (select count(*) from public.group_members where group_id = v_g) >= 100 then raise exception 'That group is full.'; end if;
  insert into public.group_members (group_id, profile_id) values (v_g, v_me) on conflict do nothing;
  return v_g;
end $$;

create function public.leave_group(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me();
begin
  delete from public.group_members where group_id = p_group and profile_id = v_me;
  if not found then return; end if;
  if not exists (select 1 from public.group_members where group_id = p_group) then
    delete from public.groups where id = p_group;
  elsif not exists (select 1 from public.group_members where group_id = p_group and role = 'owner') then
    update public.group_members set role = 'owner'
    where group_id = p_group and profile_id = (select profile_id from public.group_members where group_id = p_group order by joined_at limit 1);
  end if;
end $$;

create function public.remove_member(p_group uuid, p_profile uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me();
begin
  if not exists (select 1 from public.group_members where group_id = p_group and profile_id = v_me and role = 'owner') then
    raise exception 'Only the group owner can do that.';
  end if;
  if p_profile = v_me then raise exception 'Use Leave group instead.'; end if;
  delete from public.group_members where group_id = p_group and profile_id = p_profile;
end $$;

create function public.rotate_invite_code(p_group uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me(); v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_code text; v_b bytea; i int;
begin
  if not exists (select 1 from public.group_members where group_id = p_group and profile_id = v_me and role = 'owner') then
    raise exception 'Only the group owner can do that.';
  end if;
  perform private.throttle('rotate', 10, interval '1 hour');
  loop
    v_code := ''; v_b := extensions.gen_random_bytes(8);
    for i in 0..7 loop v_code := v_code || substr(v_alpha, (get_byte(v_b, i) % 32) + 1, 1); end loop;
    exit when not exists (select 1 from public.groups where invite_code = v_code);
  end loop;
  update public.groups set invite_code = v_code where id = p_group;
  return v_code;
end $$;

create function public.delete_group(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.group_members where group_id = p_group and profile_id = private.me() and role = 'owner') then
    raise exception 'Only the group owner can do that.';
  end if;
  delete from public.groups where id = p_group;
end $$;

-- Removes your profile and everything that hangs off it (list, memberships). The sign-in itself can be deleted in the dashboard.
create function public.delete_my_profile() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.profiles where auth_user_id = auth.uid();
  delete from public.rate_events where user_id = auth.uid();
end $$;

-- Only signed-in users may call any of these.
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('my_profile','register_profile','change_username','create_group','join_group',
                 'leave_group','remove_member','rotate_invite_code','delete_group','delete_my_profile')
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

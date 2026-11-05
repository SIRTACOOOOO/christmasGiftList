-- 0006: optional recovery question, gift priority, birthday (for the countdown), and a profile picture LINK (nothing is uploaded).

-- 1. Gift priority: 1 = high, 2 = medium, 3 = low, NULL = none.
alter table public.gifts add column priority smallint check (priority between 1 and 3);
grant insert (priority) on public.gifts to authenticated;
grant update (priority) on public.gifts to authenticated;

-- 2. Birthday (month and day only) and a profile picture link. The picture itself stays on whatever website hosts it.
alter table public.profiles
  add column birthday_month smallint,
  add column birthday_day   smallint,
  add column avatar_url     text,
  add constraint birthday_valid check (
    (birthday_month is null and birthday_day is null)
    or (birthday_month between 1 and 12 and birthday_day between 1
        and case when birthday_month = 2 then 29 when birthday_month in (4, 6, 9, 11) then 30 else 31 end)),
  add constraint avatar_url_valid check (avatar_url is null or (char_length(avatar_url) <= 500 and avatar_url ~ '^https://[^[:space:]]+$'));
grant select (birthday_month, birthday_day, avatar_url) on public.profiles to authenticated;   -- visible to group-mates only (row policy)

create function public.set_birthday(p_month int, p_day int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if private.me() is null then raise exception 'Please sign in again.'; end if;
  perform private.throttle('birthday', 20, interval '1 hour');
  begin
    update public.profiles set birthday_month = p_month, birthday_day = case when p_month is null then null else p_day end where id = private.me();
  exception when check_violation then
    raise exception 'That date is not valid.';
  end;
end $$;

create function public.set_avatar_url(p_url text) returns void
language plpgsql security definer set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if private.me() is null then raise exception 'Please sign in again.'; end if;
  perform private.throttle('avatar', 20, interval '1 hour');
  begin
    update public.profiles set avatar_url = v where id = private.me();
  exception when check_violation then
    raise exception 'Use a link to a picture that starts with https:// (500 characters at most).';
  end;
end $$;

revoke all on function public.set_birthday(int, int), public.set_avatar_url(text) from public, anon;
grant execute on function public.set_birthday(int, int), public.set_avatar_url(text) to authenticated;

-- 3. The recovery question is now optional (leave both blank). Without one, only the site owner can reset a forgotten password.
create or replace function public.service_create_profile(p_auth_user_id uuid, p_username text, p_question text, p_answer text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
  v_q    text := btrim(coalesce(p_question, ''));
  v_a    text := private.norm_answer(p_answer);
  v_hash text; v_id uuid;
begin
  if v_name !~ '^[A-Za-z0-9][A-Za-z0-9 ''.\-]{0,29}$' then raise exception 'Bad name'; end if;
  if v_q = '' and v_a = '' then
    v_q := null; v_hash := null;
  elsif char_length(v_q) not between 8 and 120 or char_length(v_a) not between 2 and 100 then
    raise exception 'Bad recovery question';
  else
    v_hash := extensions.crypt(v_a, extensions.gen_salt('bf', 10));
  end if;
  begin
    insert into public.profiles (auth_user_id, username, recovery_question, recovery_hash)
    values (p_auth_user_id, v_name::extensions.citext, v_q, v_hash) returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end $$;

create or replace function public.service_set_recovery(p_auth_user_id uuid, p_question text, p_answer text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_question, '')); v_a text := private.norm_answer(p_answer);
begin
  if v_q = '' and v_a = '' then
    update public.profiles set recovery_question = null, recovery_hash = null where auth_user_id = p_auth_user_id;
    return;
  end if;
  if char_length(v_q) not between 8 and 120 or char_length(v_a) not between 2 and 100 then raise exception 'Bad recovery question'; end if;
  update public.profiles set recovery_question = v_q, recovery_hash = extensions.crypt(v_a, extensions.gen_salt('bf', 10)) where auth_user_id = p_auth_user_id;
end $$;

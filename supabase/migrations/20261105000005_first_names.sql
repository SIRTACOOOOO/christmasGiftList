-- 0005: people enter their FULL name; other people only ever receive the first name (plus a last initial).
-- Also removes the one-time "claim code" machinery that was only needed for importing the old Google Sheet.

-- First name and last initial are derived by the database, so the browser can never be tricked into sending more.
alter table public.profiles
  add column first_name text generated always as (split_part(btrim(username::text), ' ', 1)) stored,
  add column last_initial text generated always as (
    case when position(' ' in btrim(username::text)) > 0
         then upper(left(regexp_replace(btrim(username::text), '^.*\s', ''), 1)) end) stored;

-- Other people's full names are no longer readable at all. You see your own through my_profile().
revoke select on public.profiles from authenticated;
grant select (id, first_name, last_initial, created_at) on public.profiles to authenticated;

-- Remove claim codes. (Fails if you imported old accounts that nobody has claimed: claim or delete those rows first.)
alter table public.profiles drop constraint if exists claim_only_when_unclaimed;
alter table public.profiles drop column if exists claim_hash;
alter table public.profiles alter column auth_user_id set not null;

drop function if exists public.service_create_profile(uuid, text, text, text, text);
create function public.service_create_profile(p_auth_user_id uuid, p_username text, p_question text, p_answer text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
  v_q    text := btrim(coalesce(p_question, ''));
  v_a    text := private.norm_answer(p_answer);
  v_id   uuid;
begin
  if v_name !~ '^[A-Za-z0-9][A-Za-z0-9 ''.\-]{0,29}$' then raise exception 'Bad name'; end if;
  if char_length(v_q) not between 8 and 120 or char_length(v_a) not between 2 and 100 then raise exception 'Bad recovery question'; end if;
  begin
    insert into public.profiles (auth_user_id, username, recovery_question, recovery_hash)
    values (p_auth_user_id, v_name::extensions.citext, v_q, extensions.crypt(v_a, extensions.gen_salt('bf', 10)))
    returning id into v_id;
  exception when unique_violation then
    return null;      -- that name is taken
  end;
  return v_id;
end $$;
revoke all on function public.service_create_profile(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.service_create_profile(uuid, text, text, text) to service_role;

-- Friendlier wording now that the username is a person's full name.
create or replace function public.change_username(p_username text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_name text := btrim(coalesce(p_username, ''));
begin
  if private.me() is null then raise exception 'Please sign in again.'; end if;
  if v_name !~ '^[A-Za-z0-9][A-Za-z0-9 ''.\-]{0,29}$' then
    raise exception 'Names can use letters, numbers, spaces and - . '' (30 characters at most).';
  end if;
  perform private.throttle('rename', 5, interval '1 hour');
  begin
    update public.profiles set username = v_name::extensions.citext where id = private.me();
  exception when unique_violation then
    raise exception 'Someone already has that name.';
  end;
end $$;

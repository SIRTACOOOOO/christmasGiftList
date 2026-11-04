-- 0004: username-only sign-in (no email), recovery question, service-only helpers, per-list limit.
-- Safe to run after 0001-0003. People sign in through the "account" Edge Function; the database never stores plaintext secrets.

alter table public.profiles add column recovery_question text, add column recovery_hash text;   -- hash = bcrypt of the normalised answer
alter table public.profiles add constraint recovery_question_len check (recovery_question is null or char_length(recovery_question) between 8 and 120);
-- (profiles stays readable only through column grants on id, username, created_at, so these two columns are never exposed.)

drop function if exists public.register_profile(text, text);   -- profiles are now created by the Edge Function
drop function if exists public.delete_my_profile();            -- account deletion now goes through the Edge Function

-- Throttle log for sign-in, sign-up and recovery attempts (written only by the Edge Function).
create table public.auth_events (
  id  bigint generated always as identity primary key,
  key text not null,
  at  timestamptz not null default now()
);
create index auth_events_key_idx on public.auth_events (key, at);
alter table public.auth_events enable row level security;
revoke all on public.auth_events from anon, authenticated;

create index gifts_created_by_idx on public.gifts (created_by);

-- A list may hold at most 1,000 gifts (abuse protection).
create function private.gift_count(o uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.gifts where owner_id = o
$$;
revoke all on function private.gift_count(uuid) from public, anon, authenticated;
grant execute on function private.gift_count(uuid) to authenticated;

create or replace function private.gifts_before_write() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.created_by := private.me();
      if (new.owner_id = private.me() or private.shares_group(new.owner_id)) and private.gift_count(new.owner_id) >= 1000 then
        raise exception 'That list is full (1,000 gifts).';
      end if;
    end if;
  else
    if new.owner_id is distinct from old.owner_id or new.created_by is distinct from old.created_by then
      raise exception 'Ownership cannot be changed.';
    end if;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end $$;

-- Helpers for the Edge Function. Executable by service_role ONLY. ----------------------------------------------------
create function private.norm_answer(a text) returns text language sql immutable set search_path = '' as $$
  select lower(btrim(regexp_replace(coalesce(a, ''), '\s+', ' ', 'g')))
$$;

create function public.service_rate_hits(p_key text, p_seconds int) returns int
language sql security definer set search_path = '' as $$
  select count(*)::int from public.auth_events where key = p_key and at > now() - make_interval(secs => p_seconds)
$$;

create function public.service_rate_record(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.auth_events where at < now() - interval '2 days';
  insert into public.auth_events (key) values (p_key);
end $$;

-- Creates a profile, or claims a legacy one with its one-time code. NULL = username taken / wrong code.
create function public.service_create_profile(p_auth_user_id uuid, p_username text, p_claim_code text, p_question text, p_answer text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
  v_code text := upper(regexp_replace(coalesce(p_claim_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_q    text := btrim(coalesce(p_question, ''));
  v_a    text := private.norm_answer(p_answer);
  v_old  public.profiles; v_id uuid; v_hash text;
begin
  if v_name !~ '^[A-Za-z0-9][A-Za-z0-9 ''.\-]{0,29}$' then raise exception 'Bad username'; end if;
  if char_length(v_q) not between 8 and 120 or char_length(v_a) not between 2 and 100 then raise exception 'Bad recovery question'; end if;
  v_hash := extensions.crypt(v_a, extensions.gen_salt('bf', 10));

  select * into v_old from public.profiles where username = v_name::extensions.citext;
  if found then
    if v_old.auth_user_id is null and v_old.claim_hash is not null and v_code <> ''
       and v_old.claim_hash = encode(extensions.digest(v_code, 'sha256'), 'hex') then
      update public.profiles set auth_user_id = p_auth_user_id, claim_hash = null, recovery_question = v_q, recovery_hash = v_hash where id = v_old.id;
      return v_old.id;
    end if;
    return null;
  end if;
  begin
    insert into public.profiles (auth_user_id, username, recovery_question, recovery_hash)
    values (p_auth_user_id, v_name::extensions.citext, v_q, v_hash) returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end $$;

create function public.service_get_question(p_username text) returns text
language sql stable security definer set search_path = '' as $$
  select recovery_question from public.profiles where username = btrim(p_username)::extensions.citext and auth_user_id is not null
$$;

-- Returns the auth user id when the answer is right, otherwise NULL. Always spends bcrypt time so timing does not reveal accounts.
create function public.service_check_answer(p_username text, p_answer text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid; v_hash text; v_a text := private.norm_answer(p_answer);
begin
  select auth_user_id, recovery_hash into v_uid, v_hash from public.profiles where username = btrim(p_username)::extensions.citext;
  if v_uid is null or v_hash is null then
    perform extensions.crypt(v_a, extensions.gen_salt('bf', 10));
    return null;
  end if;
  if extensions.crypt(v_a, v_hash) = v_hash then return v_uid; end if;
  return null;
end $$;

create function public.service_set_recovery(p_auth_user_id uuid, p_question text, p_answer text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_question, '')); v_a text := private.norm_answer(p_answer);
begin
  if char_length(v_q) not between 8 and 120 or char_length(v_a) not between 2 and 100 then raise exception 'Bad recovery question'; end if;
  update public.profiles set recovery_question = v_q, recovery_hash = extensions.crypt(v_a, extensions.gen_salt('bf', 10)) where auth_user_id = p_auth_user_id;
end $$;

do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'service\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

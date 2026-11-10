-- 0010: phone push notifications, replies in the group chat, full names and profiles inside a group, and prices in link previews.
-- Run this after 0009. Then follow "Phone notifications" in SETUP.md (it takes about 10 minutes).

-- ===== 1. Phone push notifications ========================================================================================
-- One row per phone or computer that turned notifications on. The two keys are never readable by browsers; only the "push"
-- Edge Function (running with the service role) can read them to send a notification.
create table public.push_subscriptions (
  endpoint   text primary key check (char_length(endpoint) between 20 and 1000 and endpoint ~ '^https://'),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  p256dh     text not null check (char_length(p256dh) between 20 and 200),
  auth       text not null check (char_length(auth) between 8 and 100),
  created_at timestamptz not null default now()
);
create index push_subscriptions_profile_idx on public.push_subscriptions (profile_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant select (endpoint, created_at) on public.push_subscriptions to authenticated;
create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (profile_id = (select private.me()));

create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me();
begin
  if v_me is null then raise exception 'Please sign in again.'; end if;
  perform private.throttle('push', 20, interval '1 hour');
  if coalesce(p_endpoint, '') !~ '^https://' or char_length(p_endpoint) > 1000 then
    raise exception 'That device cannot receive notifications.';
  end if;
  -- a device belongs to one account at a time: signing in as someone else and turning notifications on moves it
  insert into public.push_subscriptions (endpoint, profile_id, p256dh, auth) values (p_endpoint, v_me, p_p256dh, p_auth)
  on conflict (endpoint) do update set profile_id = v_me, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
  delete from public.push_subscriptions
   where profile_id = v_me
     and endpoint in (select endpoint from public.push_subscriptions where profile_id = v_me order by created_at desc offset 10);
end $$;

create function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and profile_id = private.me()
$$;

revoke all on function public.save_push_subscription(text, text, text), public.remove_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text), public.remove_push_subscription(text) to authenticated;

-- When a chat message is saved, the database pokes the "push" Edge Function, which sends the notifications.
-- The address and shared secret live in a table nobody but the database owner can read (you fill it in once, see SETUP.md).
-- Needs the pg_net extension (Database > Extensions). If it is off, or the settings are empty, nothing happens and chat still works.
create table if not exists private.push_settings (
  id     boolean primary key default true check (id),
  url    text,
  secret text
);
insert into private.push_settings (id) values (true) on conflict do nothing;
revoke all on private.push_settings from public, anon, authenticated;

create function private.notify_push() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s record;
begin
  select url, secret into s from private.push_settings where id;
  if s.url is null or s.secret is null then return new; end if;
  if new.kind = 'system' and new.event is distinct from 'santa_drawn' then return new; end if;   -- only the Secret Santa draw is worth a buzz
  begin
    perform net.http_post(url := s.url,
      headers := jsonb_build_object('content-type', 'application/json', 'x-push-secret', s.secret),
      body := jsonb_build_object('message_id', new.id));
  exception when others then
    null;      -- a notification problem must never stop a message from being saved
  end;
  return new;
end $$;
revoke all on function private.notify_push() from public, anon, authenticated;
create trigger chat_messages_push after insert on public.chat_messages for each row execute function private.notify_push();

-- ===== 2. Reply to a specific chat message ================================================================================
alter table public.chat_messages add column reply_to uuid references public.chat_messages(id) on delete set null;

drop function public.post_chat(uuid, text, boolean, uuid[]);
create function public.post_chat(p_group uuid, p_body text, p_anon boolean, p_mentions uuid[], p_reply_to uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me(); v_body text := btrim(coalesce(p_body, '')); v_id uuid; v_m uuid[]; v_r uuid;
begin
  if v_me is null or not exists (select 1 from public.group_members where group_id = p_group and profile_id = v_me) then raise exception 'Choose one of your groups.'; end if;
  if char_length(v_body) not between 1 and 1000 then raise exception 'Messages need 1 to 1,000 characters.'; end if;
  perform private.throttle('chat', 15, interval '1 minute');
  if p_reply_to is not null then
    select id into v_r from public.chat_messages where id = p_reply_to and group_id = p_group and kind = 'user';
    if v_r is null then raise exception 'That message is gone, so it cannot be replied to.'; end if;
  end if;
  v_m := array(select gm.profile_id from public.group_members gm
               where gm.group_id = p_group and gm.profile_id = any(coalesce(p_mentions, '{}'::uuid[])) limit 10);   -- only real group members can be mentioned
  delete from public.chat_messages where group_id = p_group and created_at < now() - interval '30 days';
  insert into public.chat_messages (group_id, sender_id, kind, anonymous, body, mentions, reply_to)
  values (p_group, case when coalesce(p_anon, false) then null else v_me end, 'user', coalesce(p_anon, false), v_body, v_m, v_r) returning id into v_id;
  insert into public.chat_authors (message_id, author_id) values (v_id, v_me);
  return v_id;
end $$;
revoke all on function public.post_chat(uuid, text, boolean, uuid[], uuid) from public, anon;
grant execute on function public.post_chat(uuid, text, boolean, uuid[], uuid) to authenticated;

-- ===== 3. Full names inside a group =======================================================================================
-- Other people's full names are still not readable from the profiles table. Only people who share a group can ask for the
-- full names of that one group, through this function.
create function public.group_people(p_group uuid) returns table (profile_id uuid, full_name text, role text)
language plpgsql security definer set search_path = '' as $$
begin
  if private.me() is null or not private.is_member(p_group) then raise exception 'Choose one of your groups.'; end if;
  return query
    select gm.profile_id, p.username::text, gm.role::text
      from public.group_members gm join public.profiles p on p.id = gm.profile_id
     where gm.group_id = p_group order by p.username;
end $$;
revoke all on function public.group_people(uuid) from public, anon;
grant execute on function public.group_people(uuid) to authenticated;

-- ===== 4. Link previews can carry a price (used to fill in the "Add gift" form from a link) ================================
alter table public.link_previews add column if not exists price numeric;

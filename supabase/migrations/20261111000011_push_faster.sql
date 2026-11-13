-- 0011: faster, more reliable push notifications. Run after 0010.
-- Before: the database only said "message 123 was saved" and the Edge Function then made about six database calls of its own
--         to work out who to notify. Now the database works that out in one step and hands the finished list to the function,
--         which only has to send. Also: the author is now known when we decide (so you are never notified about your own
--         message), a "push_status" check for the Settings > Notifications test, and a longer timeout.

drop trigger if exists chat_messages_push on public.chat_messages;
drop function if exists private.notify_push();

create or replace function private.push_send(p_msg uuid, p_author uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s record; m record; v_group text; v_sender text; v_reply_author uuid; v_snip text; v_items jsonb; v_system boolean;
begin
  select ps.url, ps.secret into s from private.push_settings ps where ps.id;
  if s.url is null or s.secret is null then return; end if;
  select cm.group_id, cm.sender_id, cm.anonymous, cm.body, cm.mentions, cm.reply_to, (cm.kind = 'system') as is_system
    into m from public.chat_messages cm where cm.id = p_msg;
  if not found then return; end if;
  v_system := m.is_system;
  select g.name into v_group from public.groups g where g.id = m.group_id;
  v_group := coalesce(v_group, 'Group chat');
  v_snip := left(regexp_replace(coalesce(m.body, ''), '\s+', ' ', 'g'), 140);

  if v_system then
    select coalesce(jsonb_agg(jsonb_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth, 'title', v_group,
             'body', 'The Secret Santa names were drawn' || case when v_snip <> '' then ' for "' || left(v_snip, 60) || '"' else '' end || '. Open the app to see yours.')), '[]'::jsonb)
      into v_items
      from public.push_subscriptions ps join public.group_members gm on gm.profile_id = ps.profile_id and gm.group_id = m.group_id;
  else
    v_sender := case when m.anonymous or m.sender_id is null then 'Anonymous'
                     else coalesce((select p.first_name from public.profiles p where p.id = m.sender_id), 'Someone') end;
    if m.reply_to is not null then
      select ca.author_id into v_reply_author from public.chat_authors ca where ca.message_id = m.reply_to;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth,
             'title', case when ps.profile_id = v_reply_author then v_sender || ' replied to you in ' || v_group
                           when ps.profile_id = any(coalesce(m.mentions, '{}'::uuid[])) then v_sender || ' mentioned you in ' || v_group
                           else v_group end,
             'body',  case when ps.profile_id = v_reply_author or ps.profile_id = any(coalesce(m.mentions, '{}'::uuid[])) then v_snip
                           else v_sender || ': ' || v_snip end)), '[]'::jsonb)
      into v_items
      from public.push_subscriptions ps join public.group_members gm on gm.profile_id = ps.profile_id and gm.group_id = m.group_id
     where ps.profile_id is distinct from p_author;                       -- never notify the person who wrote it
  end if;

  if jsonb_array_length(v_items) = 0 then return; end if;
  perform net.http_post(url := s.url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-push-secret', s.secret),
    body := jsonb_build_object('items', v_items, 'group', m.group_id, 'tag', 'chat-' || m.group_id),
    timeout_milliseconds := 10000);
exception when others then
  null;      -- a notification problem must never stop a message from being saved
end $$;
revoke all on function private.push_send(uuid, uuid) from public, anon, authenticated;

-- A written message: the author row is saved right after the message, so this is the moment we know who wrote it.
create or replace function private.push_after_author() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.push_send(new.message_id, new.author_id);
  return new;
end $$;
revoke all on function private.push_after_author() from public, anon, authenticated;
drop trigger if exists chat_authors_push on public.chat_authors;
create trigger chat_authors_push after insert on public.chat_authors for each row execute function private.push_after_author();

-- The Secret Santa draw is a system message with no author; it is the only system message worth a buzz.
create or replace function private.push_after_system() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'system' and new.event = 'santa_drawn' then perform private.push_send(new.id, null); end if;
  return new;
end $$;
revoke all on function private.push_after_system() from public, anon, authenticated;
create trigger chat_messages_push after insert on public.chat_messages for each row when (new.kind = 'system') execute function private.push_after_system();

-- For Settings > Notifications: is the database ready to send, and what did its last request get back? (never shows the secret)
create or replace function public.push_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_conf boolean := false; v_net boolean; v_last jsonb;
begin
  if private.me() is null then raise exception 'Please sign in again.'; end if;
  select coalesce(ps.url is not null and ps.secret is not null, false) into v_conf from private.push_settings ps where ps.id;
  v_net := exists (select 1 from pg_extension where extname = 'pg_net');
  if v_net then
    begin
      execute 'select jsonb_build_object(''status'', status_code, ''error'', error_msg, ''timed_out'', timed_out, ''at'', created) from net._http_response order by created desc limit 1' into v_last;
    exception when others then v_last := null;
    end;
  end if;
  return jsonb_build_object('configured', coalesce(v_conf, false), 'pg_net', v_net, 'last', v_last);
end $$;
revoke all on function public.push_status() from public, anon;
grant execute on function public.push_status() to authenticated;

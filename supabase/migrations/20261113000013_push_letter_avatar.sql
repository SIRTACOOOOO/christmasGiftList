-- 0013: the notification also carries what the little letter avatar needs (the first letter and the colour number), so people
-- without a profile picture get their coloured letter circle, just like in the app. Run after 0012 (it replaces that function).
-- Anonymous messages send a plain "?" and no colour.

create or replace function private.push_send(p_msg uuid, p_author uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s record; m record; v_group text; v_sender text; v_reply_author uuid; v_snip text; v_items jsonb; v_system boolean; v_icon text; v_initial text; v_hue int;
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
    v_icon := case when m.anonymous or m.sender_id is null then null else (select p.avatar_url from public.profiles p where p.id = m.sender_id) end;   -- the sender's profile picture
    v_initial := case when m.anonymous or m.sender_id is null then '?' else coalesce(upper(left((select p.first_name from public.profiles p where p.id = m.sender_id), 1)), '?') end;
    -- same colour number the app uses for the letter circle: the character codes of the person's id added up, modulo 360
    v_hue := case when m.anonymous or m.sender_id is null then null else (select (coalesce(sum(ascii(ch)), 0) % 360)::int from regexp_split_to_table(m.sender_id::text, '') as ch) end;
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
    body := jsonb_build_object('items', v_items, 'group', m.group_id, 'tag', 'chat-' || m.group_id, 'icon', v_icon, 'initial', v_initial, 'hue', v_hue),
    timeout_milliseconds := 10000);
exception when others then
  null;      -- a notification problem must never stop a message from being saved
end $$;
revoke all on function private.push_send(uuid, uuid) from public, anon, authenticated;

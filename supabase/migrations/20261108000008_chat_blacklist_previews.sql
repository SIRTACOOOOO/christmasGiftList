-- 0008: group chat (30-day memory, anonymous option, @mentions, join notices), Secret Santa blacklist and per-person budget,
--       and a cache for gift link previews.

-- ===== 1. Secret Santa budget is now PER PERSON YOU GIVE TO, and separate from the personal budget =====================
-- (The website works out what is left by adding up the gifts you have ticked on that person's list.)
drop policy if exists budget_entries_insert on public.budget_entries;
alter table public.budget_entries drop column if exists santa_id;
create policy budget_entries_insert on public.budget_entries for insert to authenticated with check (
  profile_id = (select private.me())
  and (gift_id is null or exists (select 1 from public.gifts g where g.id = gift_id)));
create or replace function private.budget_entries_before_write() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.profile_id := private.me();
      if (select count(*) from public.budget_entries where profile_id = new.profile_id) >= 500 then
        raise exception 'You have reached the limit of 500 budget entries.';
      end if;
    end if;
  elsif new.profile_id is distinct from old.profile_id or new.gift_id is distinct from old.gift_id then
    raise exception 'That cannot be changed.';
  end if;
  return new;
end $$;
drop function if exists private.santa_limit(uuid);

-- ===== 2. Secret Santa blacklist: people you must not be asked to give to. Only you can read your own. =================
create table public.santa_blacklist (
  santa_id    uuid not null references public.secret_santas(id) on delete cascade,
  giver_id    uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  primary key (santa_id, giver_id, receiver_id),
  check (giver_id <> receiver_id)
);
alter table public.santa_blacklist enable row level security;
revoke all on public.santa_blacklist from anon, authenticated;
grant select on public.santa_blacklist to authenticated;
create policy santa_blacklist_select on public.santa_blacklist for select to authenticated using (giver_id = (select private.me()));

create function public.set_santa_blacklist(p_santa uuid, p_receivers uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.secret_santas; v_me uuid := private.me(); v_r uuid[];
begin
  select * into v from public.secret_santas where id = p_santa for update;
  if not found or not exists (select 1 from public.santa_participants where santa_id = p_santa and profile_id = v_me) then raise exception 'Join the Secret Santa first.'; end if;
  if v.status <> 'open' then raise exception 'The names have already been drawn.'; end if;
  v_r := array(select distinct sp.profile_id from public.santa_participants sp
               where sp.santa_id = p_santa and sp.profile_id = any(coalesce(p_receivers, '{}'::uuid[])) and sp.profile_id <> v_me);
  if coalesce(array_length(v_r, 1), 0) > 5 then raise exception 'You can blacklist at most 5 people.'; end if;
  delete from public.santa_blacklist where santa_id = p_santa and giver_id = v_me;
  insert into public.santa_blacklist (santa_id, giver_id, receiver_id) select p_santa, v_me, r from unnest(v_r) r;
end $$;

-- ===== 3. Group chat =========================================================================================================
create table public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(id) on delete cascade,
  sender_id  uuid references public.profiles(id) on delete set null,   -- NULL for anonymous messages and system notices
  kind       text not null default 'user' check (kind in ('user', 'system')),
  anonymous  boolean not null default false,
  event      text,                                                       -- system notices: joined, left, removed, group_created, santa_created, santa_drawn, santa_reset
  subject_id uuid references public.profiles(id) on delete set null,
  body       text check (body is null or char_length(body) between 1 and 1000),
  mentions   uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  check ((kind = 'user' and body is not null) or (kind = 'system' and event is not null))
);
create index chat_messages_group_idx on public.chat_messages (group_id, created_at desc);

-- Who really wrote each message. Only the author can read their own row, which is how anonymous messages stay anonymous.
create table public.chat_authors (
  message_id uuid primary key references public.chat_messages(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade
);

alter table public.chat_messages enable row level security;
alter table public.chat_authors  enable row level security;
revoke all on public.chat_messages, public.chat_authors from anon, authenticated;
grant select on public.chat_messages, public.chat_authors to authenticated;
-- Messages older than 30 days are invisible straight away, and are deleted for good by the clean-up below.
create policy chat_messages_select on public.chat_messages for select to authenticated using (
  private.is_member(group_id) and created_at > now() - interval '30 days');
create policy chat_authors_select on public.chat_authors for select to authenticated using (author_id = (select private.me()));

create function private.chat_event(p_group uuid, p_event text, p_subject uuid, p_body text default null) returns void
language sql security definer set search_path = '' as $$
  insert into public.chat_messages (group_id, kind, event, subject_id, body) values (p_group, 'system', p_event, p_subject, p_body)
$$;
revoke all on function private.chat_event(uuid, text, uuid, text) from public, anon, authenticated;

create function public.post_chat(p_group uuid, p_body text, p_anon boolean, p_mentions uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me(); v_body text := btrim(coalesce(p_body, '')); v_id uuid; v_m uuid[];
begin
  if v_me is null or not exists (select 1 from public.group_members where group_id = p_group and profile_id = v_me) then raise exception 'Choose one of your groups.'; end if;
  if char_length(v_body) not between 1 and 1000 then raise exception 'Messages need 1 to 1,000 characters.'; end if;
  perform private.throttle('chat', 15, interval '1 minute');
  v_m := array(select gm.profile_id from public.group_members gm
               where gm.group_id = p_group and gm.profile_id = any(coalesce(p_mentions, '{}'::uuid[])) limit 10);   -- only real group members can be mentioned
  delete from public.chat_messages where group_id = p_group and created_at < now() - interval '30 days';
  insert into public.chat_messages (group_id, sender_id, kind, anonymous, body, mentions)
  values (p_group, case when coalesce(p_anon, false) then null else v_me end, 'user', coalesce(p_anon, false), v_body, v_m) returning id into v_id;
  insert into public.chat_authors (message_id, author_id) values (v_id, v_me);
  return v_id;
end $$;

create function public.delete_chat_message(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_g uuid;
begin
  select group_id into v_g from public.chat_messages where id = p_id;
  if v_g is null then return; end if;
  if exists (select 1 from public.chat_authors where message_id = p_id and author_id = private.me())
     or exists (select 1 from public.group_members where group_id = v_g and profile_id = private.me() and role = 'owner') then
    delete from public.chat_messages where id = p_id;
  else
    raise exception 'You can only delete your own messages.';
  end if;
end $$;

-- Daily clean-up of messages older than 30 days. Runs only if the pg_cron extension is switched on (Database > Extensions);
-- without it, old messages are still hidden by the rule above and removed whenever someone posts in that group.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-old-chat', '17 3 * * *', 'delete from public.chat_messages where created_at < now() - interval ''30 days''');
  end if;
exception when others then
  null;
end $$;

-- ===== 4. Link previews (filled in by the "preview" Edge Function; browsers cannot read this table) =========================
create table public.link_previews (
  url         text primary key check (char_length(url) <= 1000),
  title       text,
  description text,
  image       text,
  site        text,
  fetched_at  timestamptz not null default now()
);
alter table public.link_previews enable row level security;
revoke all on public.link_previews from anon, authenticated;

-- ===== 5. Functions that now also post chat notices (replacing the earlier versions) ========================================
create or replace function public.join_group(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me(); v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); v_g uuid; v_n int;
begin
  if v_me is null then raise exception 'Finish setting up your profile first.'; end if;
  perform private.throttle('join', 10, interval '15 minutes');
  select id into v_g from public.groups where invite_code = v_code;
  if v_g is null then return null; end if;
  if (select count(*) from public.group_members where group_id = v_g) >= 100 then raise exception 'That group is full.'; end if;
  insert into public.group_members (group_id, profile_id) values (v_g, v_me) on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then perform private.chat_event(v_g, 'joined', v_me); end if;
  return v_g;
end $$;

create or replace function public.create_group(p_name text) returns uuid
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
  perform private.chat_event(v_id, 'group_created', v_me);
  return v_id;
end $$;

create or replace function public.leave_group(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me();
begin
  delete from public.group_members where group_id = p_group and profile_id = v_me;
  if not found then return; end if;
  delete from public.santa_participants sp using public.secret_santas s
   where sp.santa_id = s.id and s.group_id = p_group and s.status = 'open' and sp.profile_id = v_me;
  if not exists (select 1 from public.group_members where group_id = p_group) then
    delete from public.groups where id = p_group;
  else
    if not exists (select 1 from public.group_members where group_id = p_group and role = 'owner') then
      update public.group_members set role = 'owner'
      where group_id = p_group and profile_id = (select profile_id from public.group_members where group_id = p_group order by joined_at limit 1);
    end if;
    perform private.chat_event(p_group, 'left', v_me);
  end if;
end $$;

create or replace function public.remove_member(p_group uuid, p_profile uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me();
begin
  if not exists (select 1 from public.group_members where group_id = p_group and profile_id = v_me and role = 'owner') then
    raise exception 'Only the group owner can do that.';
  end if;
  if p_profile = v_me then raise exception 'Use Leave group instead.'; end if;
  delete from public.group_members where group_id = p_group and profile_id = p_profile;
  if found then
    delete from public.santa_participants sp using public.secret_santas s
     where sp.santa_id = s.id and s.group_id = p_group and s.status = 'open' and sp.profile_id = p_profile;
    perform private.chat_event(p_group, 'removed', p_profile);
  end if;
end $$;

create or replace function public.create_santa(p_group uuid, p_name text, p_budget numeric, p_draws int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me(); v_name text := btrim(coalesce(p_name, '')); v_id uuid;
begin
  if v_me is null or not exists (select 1 from public.group_members where group_id = p_group and profile_id = v_me) then raise exception 'Choose one of your groups.'; end if;
  if char_length(v_name) not between 1 and 60 then raise exception 'Give the Secret Santa a name (60 characters at most).'; end if;
  if p_budget is not null and (p_budget <= 0 or p_budget >= 100000000) then raise exception 'The budget must be more than zero.'; end if;
  if p_draws not between 1 and 5 then raise exception 'Each person can draw between 1 and 5 names.'; end if;
  perform private.throttle('santa', 10, interval '1 hour');
  if (select count(*) from public.secret_santas where group_id = p_group and status = 'open') >= 10 then raise exception 'This group already has 10 open Secret Santas.'; end if;
  insert into public.secret_santas (group_id, name, budget_max, draws_per_person, created_by) values (p_group, v_name, p_budget, p_draws, v_me) returning id into v_id;
  insert into public.santa_participants (santa_id, profile_id) values (v_id, v_me);
  perform private.chat_event(p_group, 'santa_created', v_me, v_name);
  return v_id;
end $$;

create or replace function public.leave_santa(p_santa uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select status from public.secret_santas where id = p_santa) is distinct from 'open' then raise exception 'The names are already drawn, so you cannot leave.'; end if;
  delete from public.santa_participants where santa_id = p_santa and profile_id = private.me();
  delete from public.santa_blacklist where santa_id = p_santa and giver_id = private.me();
end $$;

-- The draw, now respecting blacklists. It shuffles everyone into a circle and picks k different step sizes; if a combination
-- breaks someone's blacklist it simply reshuffles (up to 400 times). Still: no self-draws, no repeats, everyone drawn exactly k times.
create or replace function public.draw_santa(p_santa uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.secret_santas; v_me uuid := private.me(); base uuid[]; ids uuid[]; offs int[]; n int; k int; tries int := 0; bad int; ok boolean := false;
begin
  select * into v from public.secret_santas where id = p_santa for update;
  if not found or not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me) then raise exception 'No such Secret Santa.'; end if;
  if v.created_by is distinct from v_me and not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me and role = 'owner') then
    raise exception 'Only the organizer or the group owner can draw the names.';
  end if;
  if v.status <> 'open' then raise exception 'The names have already been drawn.'; end if;
  k := v.draws_per_person;
  base := array(select sp.profile_id from public.santa_participants sp
                join public.group_members gm on gm.group_id = v.group_id and gm.profile_id = sp.profile_id where sp.santa_id = p_santa);
  n := coalesce(array_length(base, 1), 0);
  if n < k + 1 then raise exception 'You need at least % people for everyone to draw % name(s).', k + 1, k; end if;
  while not ok and tries < 400 loop
    tries := tries + 1;
    ids  := array(select x from unnest(base) x order by gen_random_uuid());
    offs := array(select o from generate_series(1, n - 1) o order by gen_random_uuid() limit k);
    select count(*) into bad
      from unnest(ids) with ordinality as a(id, pos)
      cross join unnest(offs) as o(step)
      join unnest(ids) with ordinality as b(id, pos) on b.pos = ((a.pos - 1 + o.step) % n) + 1
      join public.santa_blacklist bl on bl.santa_id = p_santa and bl.giver_id = a.id and bl.receiver_id = b.id;
    ok := (bad = 0);
  end loop;
  if not ok then raise exception 'No fair draw is possible with everyone''s blacklists. Ask people to shorten them, then try again.'; end if;
  insert into public.santa_assignments (santa_id, giver_id, receiver_id)
    select p_santa, a.id, b.id
      from unnest(ids) with ordinality as a(id, pos)
      cross join unnest(offs) as o(step)
      join unnest(ids) with ordinality as b(id, pos) on b.pos = ((a.pos - 1 + o.step) % n) + 1;
  if (select count(*) from public.santa_assignments where santa_id = p_santa) <> n * k
     or exists (select 1 from public.santa_assignments where santa_id = p_santa group by receiver_id having count(*) <> k) then
    raise exception 'The draw failed. Please try again.';
  end if;
  update public.secret_santas set status = 'drawn', drawn_at = now() where id = p_santa;
  perform private.chat_event(v.group_id, 'santa_drawn', v_me, v.name);
end $$;

create or replace function public.reset_santa(p_santa uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.secret_santas; v_me uuid := private.me();
begin
  select * into v from public.secret_santas where id = p_santa for update;
  if not found or (v.created_by is distinct from v_me and not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me and role = 'owner')) then
    raise exception 'Only the organizer or the group owner can do that.';
  end if;
  delete from public.santa_assignments where santa_id = p_santa;
  update public.secret_santas set status = 'open', drawn_at = null where id = p_santa;
  perform private.chat_event(v.group_id, 'santa_reset', v_me, v.name);
end $$;

revoke all on function public.set_santa_blacklist(uuid, uuid[]), public.post_chat(uuid, text, boolean, uuid[]), public.delete_chat_message(uuid) from public, anon;
grant execute on function public.set_santa_blacklist(uuid, uuid[]), public.post_chat(uuid, text, boolean, uuid[]), public.delete_chat_message(uuid) to authenticated;

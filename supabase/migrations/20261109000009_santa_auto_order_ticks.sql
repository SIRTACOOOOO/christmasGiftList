-- 0009: Secret Santa is automatic (everyone in the group is in unless they opt out), people can ask to draw fewer names,
--       gifts have a movable order instead of High/Medium/Low, and people can clear ticks after Christmas.

-- ===== 1. Gift order: a number you can move, replacing the High / Medium / Low stages ==================================
alter table public.gifts add column position integer;
create index gifts_owner_position_idx on public.gifts (owner_id, position);
update public.gifts g set position = r.rn
  from (select id, row_number() over (partition by owner_id order by created_at, id) as rn from public.gifts where created_by = owner_id) r
 where g.id = r.id;
alter table public.gifts drop column priority;

-- New gifts go to the end of the owner's own list. Changing only the order does not count as an edit.
create or replace function private.gifts_before_write() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.created_by := private.me();
      if (new.owner_id = private.me() or private.shares_group(new.owner_id)) and private.gift_count(new.owner_id) >= 1000 then
        raise exception 'That list is full (1,000 gifts).';
      end if;
    end if;
    if new.created_by is not distinct from new.owner_id then
      new.position := coalesce((select max(g.position) from public.gifts g where g.owner_id = new.owner_id), 0) + 1;
    end if;
  else
    if new.owner_id is distinct from old.owner_id or new.created_by is distinct from old.created_by then
      raise exception 'Ownership cannot be changed.';
    end if;
    new.created_at := old.created_at;
    if row(new.name, new.price, new.link, new.notes) is distinct from row(old.name, old.price, old.link, old.notes) then
      new.updated_at := now();
    else
      new.updated_at := old.updated_at;
    end if;
  end if;
  return new;
end $$;

-- Saves the order you chose: the first id becomes number 1, and so on. Gifts you leave out go after them.
create function public.reorder_gifts(p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me(); n int := coalesce(array_length(p_ids, 1), 0);
begin
  if v_me is null then raise exception 'Please sign in again.'; end if;
  if n > 1000 or (select count(distinct x) from unnest(p_ids) x) <> n then raise exception 'That order is not valid.'; end if;
  if exists (select 1 from unnest(p_ids) x where not exists (select 1 from public.gifts g where g.id = x and g.owner_id = v_me and g.created_by = v_me)) then
    raise exception 'You can only reorder your own gifts.';
  end if;
  update public.gifts g set position = o.ord from unnest(p_ids) with ordinality as o(id, ord) where g.id = o.id;
  update public.gifts g set position = n + r.rn
    from (select id, row_number() over (order by position nulls last, created_at, id) as rn
            from public.gifts where owner_id = v_me and created_by = v_me and id <> all (p_ids)) r
   where g.id = r.id;
end $$;

-- ===== 2. Clearing ticks after Christmas (the gifts themselves are never touched) =====================================
-- Clears everyone's ticks on YOUR list, so it is ready for next year. You never see how many there were.
create function public.reset_ticks_on_my_list() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.purchases p using public.gifts g
   where p.gift_id = g.id and g.owner_id = private.me() and g.created_by = g.owner_id;
end $$;

-- ===== 3. Secret Santa: in by default, opt out if you like, draw fewer names if you like ============================
create table public.santa_optouts (
  santa_id   uuid not null references public.secret_santas(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  primary key (santa_id, profile_id)
);
create table public.santa_wanted (          -- people who asked to draw fewer names than the event maximum
  santa_id   uuid not null references public.secret_santas(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  draws      smallint not null check (draws between 1 and 5),
  primary key (santa_id, profile_id)
);
alter table public.santa_optouts enable row level security;
alter table public.santa_wanted  enable row level security;
revoke all on public.santa_optouts, public.santa_wanted from anon, authenticated;
grant select on public.santa_optouts, public.santa_wanted to authenticated;
create policy santa_optouts_select on public.santa_optouts for select to authenticated using (private.is_member(private.santa_group(santa_id)));
create policy santa_wanted_select  on public.santa_wanted  for select to authenticated using (private.is_member(private.santa_group(santa_id)));

drop function if exists public.join_santa(uuid);
drop function if exists public.leave_santa(uuid);

create function public.set_santa_optout(p_santa uuid, p_out boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.secret_santas; v_me uuid := private.me();
begin
  select * into v from public.secret_santas where id = p_santa for update;
  if not found or not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me) then raise exception 'No such Secret Santa.'; end if;
  if v.status <> 'open' then raise exception 'The names have already been drawn.'; end if;
  if coalesce(p_out, false) then
    insert into public.santa_optouts (santa_id, profile_id) values (p_santa, v_me) on conflict do nothing;
    delete from public.santa_wanted where santa_id = p_santa and profile_id = v_me;
    delete from public.santa_blacklist where santa_id = p_santa and giver_id = v_me;
  else
    delete from public.santa_optouts where santa_id = p_santa and profile_id = v_me;
  end if;
end $$;

-- "I want fewer gifts": your name goes in the pool, and you draw, only this many times (1 up to the event maximum).
create function public.set_santa_draws(p_santa uuid, p_draws int) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.secret_santas; v_me uuid := private.me();
begin
  select * into v from public.secret_santas where id = p_santa for update;
  if not found or not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me) then raise exception 'No such Secret Santa.'; end if;
  if v.status <> 'open' then raise exception 'The names have already been drawn.'; end if;
  if exists (select 1 from public.santa_optouts where santa_id = p_santa and profile_id = v_me) then raise exception 'Opt back in first.'; end if;
  if p_draws is null or p_draws < 1 or p_draws > v.draws_per_person then raise exception 'Choose a number from 1 to %.', v.draws_per_person; end if;
  if p_draws = v.draws_per_person then
    delete from public.santa_wanted where santa_id = p_santa and profile_id = v_me;
  else
    insert into public.santa_wanted (santa_id, profile_id, draws) values (p_santa, v_me, p_draws)
    on conflict (santa_id, profile_id) do update set draws = excluded.draws;
  end if;
end $$;

-- Your private "do not give to" list (a spouse, say). Only people who are in the Secret Santa can be listed.
create or replace function public.set_santa_blacklist(p_santa uuid, p_receivers uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.secret_santas; v_me uuid := private.me(); v_r uuid[];
begin
  select * into v from public.secret_santas where id = p_santa for update;
  if not found or not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me) then raise exception 'No such Secret Santa.'; end if;
  if v.status <> 'open' then raise exception 'The names have already been drawn.'; end if;
  if exists (select 1 from public.santa_optouts where santa_id = p_santa and profile_id = v_me) then raise exception 'Opt back in first.'; end if;
  v_r := array(select distinct gm.profile_id from public.group_members gm
               where gm.group_id = v.group_id and gm.profile_id = any (coalesce(p_receivers, '{}'::uuid[])) and gm.profile_id <> v_me
                 and not exists (select 1 from public.santa_optouts o where o.santa_id = p_santa and o.profile_id = gm.profile_id));
  if coalesce(array_length(v_r, 1), 0) > 5 then raise exception 'You can list at most 5 people.'; end if;
  delete from public.santa_blacklist where santa_id = p_santa and giver_id = v_me;
  insert into public.santa_blacklist (santa_id, giver_id, receiver_id) select p_santa, v_me, r from unnest(v_r) r;
end $$;

-- Creating one no longer adds anyone by hand: the whole group is in.
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
  perform private.chat_event(p_group, 'santa_created', v_me, v_name);
  return v_id;
end $$;

-- The draw: a hat of names. Each person puts their name in once per name they will draw (so someone who asked for fewer is in the
-- hat fewer times), then everyone draws that many names in turn. Nobody draws themselves, nobody draws the same person twice, nobody
-- draws someone on their private list. If the hat gets stuck, everything is put back and redrawn (up to 500 times).
create or replace function public.draw_santa(p_santa uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.secret_santas; v_me uuid := private.me();
  ppl uuid[]; want int[]; pool0 uuid[] := '{}'; pool uuid[]; order_ids uuid[]; picked uuid[];
  ga uuid[]; ra uuid[]; pick record; giver uuid; n int; d int; i int; j int; tries int := 0; ok boolean := false;
begin
  select * into v from public.secret_santas where id = p_santa for update;
  if not found or not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me) then raise exception 'No such Secret Santa.'; end if;
  if v.created_by is distinct from v_me and not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me and role = 'owner') then
    raise exception 'Only the organizer or the group owner can draw the names.';
  end if;
  if v.status <> 'open' then raise exception 'The names have already been drawn.'; end if;

  ppl := array(select gm.profile_id from public.group_members gm
               where gm.group_id = v.group_id
                 and not exists (select 1 from public.santa_optouts o where o.santa_id = p_santa and o.profile_id = gm.profile_id)
               order by gm.profile_id);
  n := coalesce(array_length(ppl, 1), 0);
  if n < 2 then raise exception 'You need at least 2 people in the Secret Santa.'; end if;
  want := array(select least(coalesce(w.draws, v.draws_per_person), v.draws_per_person, n - 1)::int
                from unnest(ppl) with ordinality as p(id, pos)
                left join public.santa_wanted w on w.santa_id = p_santa and w.profile_id = p.id order by p.pos);
  for i in 1..n loop for j in 1..want[i] loop pool0 := pool0 || ppl[i]; end loop; end loop;

  while not ok and tries < 500 loop
    tries := tries + 1; ok := true; pool := pool0; ga := '{}'; ra := '{}';
    order_ids := array(select x from unnest(ppl) x order by gen_random_uuid());
    foreach giver in array order_ids loop
      d := want[array_position(ppl, giver)]; picked := '{}';
      for j in 1..d loop
        select u.id as pid, u.pos as ppos into pick
          from unnest(pool) with ordinality as u(id, pos)
         where u.id <> giver and not (u.id = any (picked))
           and not exists (select 1 from public.santa_blacklist bl where bl.santa_id = p_santa and bl.giver_id = giver and bl.receiver_id = u.id)
         order by gen_random_uuid() limit 1;
        if not found then ok := false; exit; end if;
        picked := picked || pick.pid; ga := ga || giver; ra := ra || pick.pid;
        pool := pool[1:pick.ppos - 1] || pool[pick.ppos + 1:array_length(pool, 1)];
      end loop;
      exit when not ok;
    end loop;
  end loop;
  if not ok then raise exception 'No fair draw is possible with these choices. Try asking people to shorten their "do not give to" lists or to draw the same number of names, then draw again.'; end if;

  insert into public.santa_assignments (santa_id, giver_id, receiver_id) select p_santa, t.g, t.r from unnest(ga, ra) as t(g, r);
  insert into public.santa_participants (santa_id, profile_id) select p_santa, x from unnest(ppl) x;
  if (select count(*) from public.santa_assignments where santa_id = p_santa) <> array_length(pool0, 1)
     or exists (select 1 from unnest(ppl) with ordinality as p(id, pos)
                 where (select count(*) from public.santa_assignments a where a.santa_id = p_santa and a.giver_id = p.id) <> want[p.pos]
                    or (select count(*) from public.santa_assignments a where a.santa_id = p_santa and a.receiver_id = p.id) <> want[p.pos]) then
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
  delete from public.santa_participants where santa_id = p_santa;
  update public.secret_santas set status = 'open', drawn_at = null where id = p_santa;
  perform private.chat_event(v.group_id, 'santa_reset', v_me, v.name);
end $$;

revoke all on function public.reorder_gifts(uuid[]), public.reset_ticks_on_my_list(), public.set_santa_optout(uuid, boolean), public.set_santa_draws(uuid, int) from public, anon;
grant execute on function public.reorder_gifts(uuid[]), public.reset_ticks_on_my_list(), public.set_santa_optout(uuid, boolean), public.set_santa_draws(uuid, int) to authenticated;

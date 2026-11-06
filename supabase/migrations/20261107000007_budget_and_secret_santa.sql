-- 0007: personal budget tracker and Secret Santa.
-- Privacy rules (enforced here, not in the browser):
--   * Budget entries and totals are visible only to their owner.
--   * Secret Santa assignments are visible only to the giver. Nobody else, including the organizer, can read them.

-- ===== Secret Santa =================================================================================================
create table public.secret_santas (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references public.groups(id) on delete cascade,
  name             text not null check (char_length(btrim(name)) between 1 and 60),
  budget_max       numeric(10,2) check (budget_max is null or budget_max > 0),   -- group spending limit per gift
  draws_per_person smallint not null default 1 check (draws_per_person between 1 and 5),
  status           text not null default 'open' check (status in ('open', 'drawn')),
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  drawn_at         timestamptz
);
create index secret_santas_group_idx on public.secret_santas (group_id);

create table public.santa_participants (
  santa_id   uuid not null references public.secret_santas(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (santa_id, profile_id)
);

-- One row = "giver gives to receiver". The primary key makes a repeated pairing impossible; the check makes drawing yourself impossible.
create table public.santa_assignments (
  santa_id    uuid not null references public.secret_santas(id) on delete cascade,
  giver_id    uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  primary key (santa_id, giver_id, receiver_id),
  constraint cannot_draw_yourself check (giver_id <> receiver_id)
);
create index santa_assignments_receiver_idx on public.santa_assignments (santa_id, receiver_id);

-- ===== Budget tracker ================================================================================================
create table public.budgets (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  total      numeric(10,2) check (total is null or total >= 0),
  updated_at timestamptz not null default now()
);

create table public.budget_entries (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  gift_id    uuid references public.gifts(id) on delete set null,
  santa_id   uuid references public.secret_santas(id) on delete set null,
  label      text not null check (char_length(btrim(label)) between 1 and 100),
  kind       text not null check (kind in ('reserved', 'spent')),
  amount     numeric(10,2) not null check (amount >= 0 and amount < 100000000),
  created_at timestamptz not null default now()
);
create index budget_entries_profile_idx on public.budget_entries (profile_id, created_at);

-- ===== Helpers =========================================================================================================
create function private.santa_group(s uuid) returns uuid language sql stable security definer set search_path = '' as $$
  select group_id from public.secret_santas where id = s
$$;
create function private.in_santa(s uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.santa_participants where santa_id = s and profile_id = private.me())
$$;
create function private.santa_limit(s uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select budget_max from public.secret_santas where id = s
$$;
revoke all on function private.santa_group(uuid), private.in_santa(uuid), private.santa_limit(uuid) from public, anon, authenticated;
grant execute on function private.santa_group(uuid), private.in_santa(uuid) to authenticated;

-- Budget entries: the owner is set by the database; an entry tied to a Secret Santa cannot go over the group's spending limit.
create function private.budget_entries_before_write() returns trigger language plpgsql set search_path = '' as $$
declare v_max numeric;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.profile_id := private.me();
      if (select count(*) from public.budget_entries where profile_id = new.profile_id) >= 500 then
        raise exception 'You have reached the limit of 500 budget entries.';
      end if;
    end if;
  elsif new.profile_id is distinct from old.profile_id or new.gift_id is distinct from old.gift_id or new.santa_id is distinct from old.santa_id then
    raise exception 'That cannot be changed.';
  end if;
  if new.santa_id is not null then
    v_max := private.santa_limit(new.santa_id);
    if v_max is not null and new.amount > v_max then
      raise exception 'That is over the group spending limit of %.', to_char(v_max, 'FM999999990.00');
    end if;
  end if;
  return new;
end $$;
revoke all on function private.budget_entries_before_write() from public, anon, authenticated;
create trigger budget_entries_before_write before insert or update on public.budget_entries
  for each row execute function private.budget_entries_before_write();
grant execute on function private.santa_limit(uuid) to authenticated;   -- the trigger runs as the signed-in user

-- ===== Row Level Security ==============================================================================================
alter table public.secret_santas      enable row level security;
alter table public.santa_participants enable row level security;
alter table public.santa_assignments  enable row level security;
alter table public.budgets            enable row level security;
alter table public.budget_entries     enable row level security;
revoke all on public.secret_santas, public.santa_participants, public.santa_assignments, public.budgets, public.budget_entries from anon, authenticated;

-- Santa events and participant lists: visible to members of the group. Writes only through the functions below.
grant select on public.secret_santas, public.santa_participants to authenticated;
create policy santas_select on public.secret_santas for select to authenticated using (private.is_member(group_id));
create policy santa_participants_select on public.santa_participants for select to authenticated using (private.is_member(private.santa_group(santa_id)));

-- Assignments: you can read ONLY the rows where you are the giver.
grant select on public.santa_assignments to authenticated;
create policy santa_assignments_select on public.santa_assignments for select to authenticated using (giver_id = (select private.me()));

-- Budget: strictly your own rows.
grant select on public.budgets to authenticated;
create policy budgets_select on public.budgets for select to authenticated using (profile_id = (select private.me()));

grant select, delete on public.budget_entries to authenticated;
grant insert (id, gift_id, santa_id, label, kind, amount) on public.budget_entries to authenticated;
grant update (label, kind, amount) on public.budget_entries to authenticated;
create policy budget_entries_select on public.budget_entries for select to authenticated using (profile_id = (select private.me()));
create policy budget_entries_insert on public.budget_entries for insert to authenticated with check (
  profile_id = (select private.me())
  and (gift_id is null or exists (select 1 from public.gifts g where g.id = gift_id))      -- only gifts you are allowed to see
  and (santa_id is null or private.in_santa(santa_id)));
create policy budget_entries_update on public.budget_entries for update to authenticated
  using (profile_id = (select private.me())) with check (profile_id = (select private.me()));
create policy budget_entries_delete on public.budget_entries for delete to authenticated using (profile_id = (select private.me()));

-- ===== Functions ========================================================================================================
create function public.set_budget_total(p_total numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if private.me() is null then raise exception 'Please sign in again.'; end if;
  if p_total is not null and (p_total < 0 or p_total >= 100000000) then raise exception 'That budget is not valid.'; end if;
  insert into public.budgets (profile_id, total) values (private.me(), p_total)
  on conflict (profile_id) do update set total = excluded.total, updated_at = now();
end $$;

create function public.create_santa(p_group uuid, p_name text, p_budget numeric, p_draws int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.me(); v_name text := btrim(coalesce(p_name, '')); v_id uuid;
begin
  if v_me is null or not exists (select 1 from public.group_members where group_id = p_group and profile_id = v_me) then raise exception 'Choose one of your groups.'; end if;
  if char_length(v_name) not between 1 and 60 then raise exception 'Give the Secret Santa a name (60 characters at most).'; end if;
  if p_budget is not null and (p_budget <= 0 or p_budget >= 100000000) then raise exception 'The spending limit must be more than zero.'; end if;
  if p_draws not between 1 and 5 then raise exception 'Each person can draw between 1 and 5 names.'; end if;
  perform private.throttle('santa', 10, interval '1 hour');
  if (select count(*) from public.secret_santas where group_id = p_group and status = 'open') >= 10 then raise exception 'This group already has 10 open Secret Santas.'; end if;
  insert into public.secret_santas (group_id, name, budget_max, draws_per_person, created_by) values (p_group, v_name, p_budget, p_draws, v_me) returning id into v_id;
  insert into public.santa_participants (santa_id, profile_id) values (v_id, v_me);
  return v_id;
end $$;

create function public.join_santa(p_santa uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.secret_santas;
begin
  select * into v from public.secret_santas where id = p_santa;
  if not found or not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = private.me()) then raise exception 'No such Secret Santa.'; end if;
  if v.status <> 'open' then raise exception 'The names have already been drawn.'; end if;
  if (select count(*) from public.santa_participants where santa_id = p_santa) >= 200 then raise exception 'This Secret Santa is full.'; end if;
  insert into public.santa_participants (santa_id, profile_id) values (p_santa, private.me()) on conflict do nothing;
end $$;

create function public.leave_santa(p_santa uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select status from public.secret_santas where id = p_santa) is distinct from 'open' then raise exception 'The names are already drawn, so you cannot leave.'; end if;
  delete from public.santa_participants where santa_id = p_santa and profile_id = private.me();
end $$;

-- The draw. Everyone is shuffled into a circle; each person gives to the people 'offset' places ahead, for k different offsets.
-- So nobody draws themselves, nobody draws the same person twice, and everyone is drawn exactly k times. All or nothing.
create function public.draw_santa(p_santa uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.secret_santas; v_me uuid := private.me(); ids uuid[]; offs int[]; n int; k int; i int; j int;
begin
  select * into v from public.secret_santas where id = p_santa for update;
  if not found or not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me) then raise exception 'No such Secret Santa.'; end if;
  if v.created_by is distinct from v_me and not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me and role = 'owner') then
    raise exception 'Only the organizer or the group owner can draw the names.';
  end if;
  if v.status <> 'open' then raise exception 'The names have already been drawn.'; end if;
  k := v.draws_per_person;
  ids := array(select sp.profile_id from public.santa_participants sp
               join public.group_members gm on gm.group_id = v.group_id and gm.profile_id = sp.profile_id
               where sp.santa_id = p_santa order by gen_random_uuid());
  n := coalesce(array_length(ids, 1), 0);
  if n < k + 1 then raise exception 'You need at least % people for everyone to draw % name(s).', k + 1, k; end if;
  offs := array(select o from generate_series(1, n - 1) o order by gen_random_uuid() limit k);
  for i in 1..n loop
    foreach j in array offs loop
      insert into public.santa_assignments (santa_id, giver_id, receiver_id) values (p_santa, ids[i], ids[((i - 1 + j) % n) + 1]);
    end loop;
  end loop;
  if (select count(*) from public.santa_assignments where santa_id = p_santa) <> n * k
     or exists (select 1 from public.santa_assignments where santa_id = p_santa group by receiver_id having count(*) <> k) then
    raise exception 'The draw failed. Please try again.';
  end if;
  update public.secret_santas set status = 'drawn', drawn_at = now() where id = p_santa;
end $$;

create function public.reset_santa(p_santa uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.secret_santas; v_me uuid := private.me();
begin
  select * into v from public.secret_santas where id = p_santa for update;
  if not found or (v.created_by is distinct from v_me and not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me and role = 'owner')) then
    raise exception 'Only the organizer or the group owner can do that.';
  end if;
  delete from public.santa_assignments where santa_id = p_santa;
  update public.secret_santas set status = 'open', drawn_at = null where id = p_santa;
end $$;

create function public.delete_santa(p_santa uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.secret_santas; v_me uuid := private.me();
begin
  select * into v from public.secret_santas where id = p_santa;
  if not found or (v.created_by is distinct from v_me and not exists (select 1 from public.group_members where group_id = v.group_id and profile_id = v_me and role = 'owner')) then
    raise exception 'Only the organizer or the group owner can do that.';
  end if;
  delete from public.secret_santas where id = p_santa;
end $$;

-- Leaving or being removed from a group also removes you from that group's OPEN Secret Santas.
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
  elsif not exists (select 1 from public.group_members where group_id = p_group and role = 'owner') then
    update public.group_members set role = 'owner'
    where group_id = p_group and profile_id = (select profile_id from public.group_members where group_id = p_group order by joined_at limit 1);
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
  delete from public.santa_participants sp using public.secret_santas s
   where sp.santa_id = s.id and s.group_id = p_group and s.status = 'open' and sp.profile_id = p_profile;
end $$;

revoke all on function public.set_budget_total(numeric), public.create_santa(uuid, text, numeric, int), public.join_santa(uuid),
  public.leave_santa(uuid), public.draw_santa(uuid), public.reset_santa(uuid), public.delete_santa(uuid) from public, anon;
grant execute on function public.set_budget_total(numeric), public.create_santa(uuid, text, numeric, int), public.join_santa(uuid),
  public.leave_santa(uuid), public.draw_santa(uuid), public.reset_santa(uuid), public.delete_santa(uuid) to authenticated;

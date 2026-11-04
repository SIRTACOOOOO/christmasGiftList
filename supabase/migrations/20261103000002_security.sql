-- 0002: helper functions, Row Level Security, and table privileges.
-- Rule of thumb used below: the browser can only do what a policy allows. Everything else goes through RPCs (0003).

-- Helpers (SECURITY DEFINER so they can read membership tables without recursing into RLS) -----------------
create function private.me() returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.profiles where auth_user_id = auth.uid()
$$;

create function private.shares_group(other uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members a join public.group_members b on a.group_id = b.group_id
    where a.profile_id = private.me() and b.profile_id = other
  )
$$;

create function private.is_member(g uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.group_members where group_id = g and profile_id = private.me())
$$;

-- true when the caller may see/change the purchase mark of this gift: someone else's list, in a shared group
create function private.can_see_purchase(g uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.gifts x
    where x.id = g and x.owner_id is distinct from private.me() and private.shares_group(x.owner_id)
  )
$$;

create function private.gift_is_surprise(g uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select created_by is distinct from owner_id from public.gifts where id = g), false)
$$;

create function private.throttle(p_kind text, p_max int, p_window interval) returns void
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  delete from public.rate_events where at < now() - interval '1 day';
  select count(*) into n from public.rate_events where user_id = auth.uid() and kind = p_kind and at > now() - p_window;
  if n >= p_max then raise exception 'Too many attempts. Please try again later.'; end if;
  insert into public.rate_events (user_id, kind) values (auth.uid(), p_kind);
end $$;

-- Function privileges ----------------------------------------------------------------------------------
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.me(), private.shares_group(uuid), private.is_member(uuid),
                          private.can_see_purchase(uuid), private.gift_is_surprise(uuid) to authenticated;

-- Row Level Security on every table ----------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.gifts         enable row level security;
alter table public.purchases     enable row level security;
alter table public.rate_events   enable row level security;

-- Start from nothing, then grant the minimum.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- profiles: only id + username are readable (never claim_hash or auth_user_id). Writes go through RPCs.
grant select (id, username, created_at) on public.profiles to authenticated;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select private.me()) or private.shares_group(id));

-- groups and members: members only. Writes go through RPCs.
grant select on public.groups, public.group_members to authenticated;
create policy groups_select on public.groups for select to authenticated using (private.is_member(id));
create policy group_members_select on public.group_members for select to authenticated using (private.is_member(group_id));

-- gifts
--   * You see your own list, except surprise gifts someone else added to it.
--   * You see other people's lists when you share a group with them (surprise gifts included).
grant select, delete on public.gifts to authenticated;
grant insert (id, owner_id, name, price, link, notes) on public.gifts to authenticated;
grant update (name, price, link, notes) on public.gifts to authenticated;

create policy gifts_select on public.gifts for select to authenticated using (
  case when owner_id = (select private.me()) then created_by = owner_id
       else private.shares_group(owner_id) end
);
-- created_by is forced to the caller by a trigger, so: own list, or a surprise gift on a group-mate's list.
create policy gifts_insert on public.gifts for insert to authenticated with check (
  created_by = (select private.me())
  and (owner_id = (select private.me()) or private.shares_group(owner_id))
);
create policy gifts_update on public.gifts for update to authenticated
  using (
    (owner_id = (select private.me()) and created_by = owner_id)
    or (created_by = (select private.me()) and owner_id <> (select private.me()) and private.shares_group(owner_id))
  )
  with check (
    (owner_id = (select private.me()) and created_by = owner_id)
    or (created_by = (select private.me()) and owner_id <> (select private.me()) and private.shares_group(owner_id))
  );
create policy gifts_delete on public.gifts for delete to authenticated using (
  (owner_id = (select private.me()) and created_by = owner_id)
  or (created_by = (select private.me()) and owner_id <> (select private.me()))
);

-- purchases: never visible to the owner of the gift; surprise gifts are marked bought automatically and stay that way.
grant select, delete on public.purchases to authenticated;
grant insert (gift_id, bought_by) on public.purchases to authenticated;
create policy purchases_select on public.purchases for select to authenticated using (private.can_see_purchase(gift_id));
create policy purchases_insert on public.purchases for insert to authenticated with check (
  bought_by = (select private.me()) and private.can_see_purchase(gift_id) and not private.gift_is_surprise(gift_id)
);
create policy purchases_delete on public.purchases for delete to authenticated using (
  private.can_see_purchase(gift_id) and not private.gift_is_surprise(gift_id)
);

-- rate_events: no policies and no grants. Only the SECURITY DEFINER functions touch it.

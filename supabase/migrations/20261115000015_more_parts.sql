-- 0015: gifts with more than two parts ("this and this and that", "this or this or that"). Run after 14.
-- Part 1 and part 2 live in the columns from 0014. Parts 3 to 6 live in "more", a list like
--   [{"name": "Gloves", "price": 12.5, "link": "https://...", "notes": "size M"}, ...]
-- The kind ('or' / 'and') applies to every part.

alter table public.gifts add column more jsonb not null default '[]'::jsonb;

-- Checks the list in "more": up to 4 parts, each with a name (1 to 200 characters), and an optional price, link and notes.
create function private.valid_more(j jsonb) returns boolean language plpgsql immutable set search_path = '' as $$
declare e jsonb;
begin
  if jsonb_typeof(j) is distinct from 'array' or jsonb_array_length(j) > 4 then return false; end if;
  for e in select x from jsonb_array_elements(j) as x loop
    if jsonb_typeof(e) is distinct from 'object' then return false; end if;
    if jsonb_typeof(e -> 'name') is distinct from 'string' or char_length(btrim(e ->> 'name')) not between 1 and 200 then return false; end if;
    if jsonb_typeof(e -> 'price') = 'number' then
      if (e ->> 'price')::numeric < 0 or (e ->> 'price')::numeric >= 100000000 then return false; end if;
    elsif e ? 'price' and jsonb_typeof(e -> 'price') <> 'null' then return false; end if;
    if e ? 'link' and jsonb_typeof(e -> 'link') <> 'null' and (jsonb_typeof(e -> 'link') <> 'string' or char_length(e ->> 'link') > 1000) then return false; end if;
    if e ? 'notes' and jsonb_typeof(e -> 'notes') <> 'null' and (jsonb_typeof(e -> 'notes') <> 'string' or char_length(e ->> 'notes') > 1000) then return false; end if;
  end loop;
  return true;
end $$;
grant execute on function private.valid_more(jsonb) to authenticated;

alter table public.gifts drop constraint gifts_two_parts;
alter table public.gifts add constraint gifts_two_parts check (
  (kind = 'single' and name2 is null and price2 is null and link2 is null and notes2 is null and more = '[]'::jsonb)
  or (kind <> 'single' and name2 is not null));
alter table public.gifts add constraint gifts_more_valid check (private.valid_more(more) and (name2 is not null or more = '[]'::jsonb));
alter table public.gifts add constraint gifts_more_size check (char_length(more::text) <= 8000);
grant insert (more) on public.gifts to authenticated;
grant update (more) on public.gifts to authenticated;

-- How many parts a gift has
create function private.gift_parts(p_kind text, p_more jsonb) returns int language sql immutable set search_path = '' as $$
  select case when p_kind = 'single' then 1 else 2 + jsonb_array_length(p_more) end
$$;
grant execute on function private.gift_parts(text, jsonb) to authenticated;

-- Editing any part counts as an edit (same function as before, now also watching "more")
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
    if row(new.name, new.price, new.link, new.notes, new.kind, new.name2, new.price2, new.link2, new.notes2, new.more)
       is distinct from row(old.name, old.price, old.link, old.notes, old.kind, old.name2, old.price2, old.link2, old.notes2, old.more) then
      new.updated_at := now();
    else
      new.updated_at := old.updated_at;
    end if;
  end if;
  return new;
end $$;

-- Up to six parts can be ticked; a part that does not exist cannot
alter table public.purchases drop constraint purchases_part_check;
alter table public.purchases add constraint purchases_part_check check (part between 1 and 6);

create or replace function private.purchases_before_insert() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_more jsonb;
begin
  select g.kind, g.more into v_kind, v_more from public.gifts g where g.id = new.gift_id;
  if v_kind is null then return new; end if;                       -- the row-level security policy deals with unknown gifts
  if new.part > private.gift_parts(v_kind, v_more) then raise exception 'This gift does not have that many parts.'; end if;
  if v_kind = 'or' and exists (select 1 from public.purchases p where p.gift_id = new.gift_id and p.part <> new.part) then
    raise exception 'Someone already ticked another choice of this "or" gift.';
  end if;
  return new;
end $$;

-- A surprise gift is bought by definition: every part of an "and" gift, or the one part of anything else.
create or replace function private.gifts_after_insert() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.created_by is distinct from new.owner_id then
    insert into public.purchases (gift_id, bought_by, part)
      select new.id, new.created_by, n from generate_series(1, case when new.kind = 'and' then private.gift_parts(new.kind, new.more) else 1 end) n
    on conflict do nothing;
  end if;
  return new;
end $$;

-- Changing the kind or the number of parts later keeps the ticks sensible (the owner cannot see or touch ticks, so this is done here).
create or replace function private.gifts_after_update() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_keep smallint; v_n int := private.gift_parts(new.kind, new.more);
begin
  delete from public.purchases where gift_id = new.id and part > v_n;
  if new.kind = 'or' and new.kind is distinct from old.kind then   -- keep only the earliest tick
    select p.part into v_keep from public.purchases p where p.gift_id = new.id order by p.bought_at, p.part limit 1;
    if v_keep is not null then delete from public.purchases where gift_id = new.id and part <> v_keep; end if;
  end if;
  if new.kind = 'and' and new.created_by is distinct from new.owner_id then
    insert into public.purchases (gift_id, bought_by, part) select new.id, new.created_by, n from generate_series(1, v_n) n on conflict do nothing;
  end if;
  return new;
end $$;

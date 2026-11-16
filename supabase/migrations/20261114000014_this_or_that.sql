-- 0014: "this or that" and "this and that" gifts. Run after 13.
--   kind 'single' = a normal gift.
--   kind 'or'     = two choices, either one is fine. Ticking one ticks both (only one purchase is saved: the part that was bought).
--   kind 'and'    = two gifts that go together. Each part is ticked on its own.
-- The second part has its own name, price, link and notes.

-- ===== 1. The second part of a gift ======================================================================================
alter table public.gifts
  add column kind   text not null default 'single' check (kind in ('single', 'or', 'and')),
  add column name2  text check (name2 is null or char_length(btrim(name2)) between 1 and 200),
  add column price2 numeric(10,2) check (price2 is null or price2 >= 0),
  add column link2  text check (link2 is null or char_length(link2) <= 1000),
  add column notes2 text check (notes2 is null or char_length(notes2) <= 1000),
  add constraint gifts_two_parts check (
    (kind = 'single' and name2 is null and price2 is null and link2 is null and notes2 is null)
    or (kind <> 'single' and name2 is not null));
grant insert (kind, name2, price2, link2, notes2) on public.gifts to authenticated;
grant update (kind, name2, price2, link2, notes2) on public.gifts to authenticated;

-- Same as before (ownership is fixed, list size is capped, new gifts go to the end), but changing the second part also counts as an edit.
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
    if row(new.name, new.price, new.link, new.notes, new.kind, new.name2, new.price2, new.link2, new.notes2)
       is distinct from row(old.name, old.price, old.link, old.notes, old.kind, old.name2, old.price2, old.link2, old.notes2) then
      new.updated_at := now();
    else
      new.updated_at := old.updated_at;
    end if;
  end if;
  return new;
end $$;

-- ===== 2. Which part was bought ==========================================================================================
alter table public.purchases add column part smallint not null default 1 check (part in (1, 2));
alter table public.purchases drop constraint purchases_pkey;
alter table public.purchases add primary key (gift_id, part);
grant insert (part) on public.purchases to authenticated;

-- A single gift has only part 1. An "or" gift can only have ONE part ticked: if someone already ticked a choice, the other cannot be.
create function private.purchases_before_insert() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_kind text;
begin
  select g.kind into v_kind from public.gifts g where g.id = new.gift_id;
  if v_kind is null then return new; end if;                       -- the row-level security policy deals with unknown gifts
  if new.part = 2 and v_kind = 'single' then raise exception 'This gift has only one part.'; end if;
  if v_kind = 'or' and exists (select 1 from public.purchases p where p.gift_id = new.gift_id and p.part <> new.part) then
    raise exception 'Someone already ticked the other choice of this "or" gift.';
  end if;
  return new;
end $$;
revoke all on function private.purchases_before_insert() from public, anon, authenticated;
create trigger purchases_before_insert before insert on public.purchases for each row execute function private.purchases_before_insert();

-- A surprise gift is bought by definition: every part of it.
create or replace function private.gifts_after_insert() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.created_by is distinct from new.owner_id then
    insert into public.purchases (gift_id, bought_by, part) values (new.id, new.created_by, 1) on conflict do nothing;
    if new.kind = 'and' then
      insert into public.purchases (gift_id, bought_by, part) values (new.id, new.created_by, 2) on conflict do nothing;
    end if;
  end if;
  return new;
end $$;

-- Changing the kind of a gift later keeps the ticks sensible (the owner cannot see or touch ticks, so this is done here).
create function private.gifts_after_update() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_keep smallint;
begin
  if new.kind is distinct from old.kind then
    if new.kind = 'single' then
      delete from public.purchases where gift_id = new.id and part = 2;
    elsif new.kind = 'or' then                                       -- keep only the earliest tick
      select p.part into v_keep from public.purchases p where p.gift_id = new.id order by p.bought_at, p.part limit 1;
      if v_keep is not null then delete from public.purchases where gift_id = new.id and part <> v_keep; end if;
    elsif new.kind = 'and' and new.created_by is distinct from new.owner_id then   -- a surprise gift is bought, all of it
      insert into public.purchases (gift_id, bought_by, part) values (new.id, new.created_by, 2) on conflict do nothing;
    end if;
  end if;
  return new;
end $$;
revoke all on function private.gifts_after_update() from public, anon, authenticated;
create trigger gifts_after_update after update on public.gifts for each row execute function private.gifts_after_update();

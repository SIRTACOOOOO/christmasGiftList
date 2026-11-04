-- 0001: tables, constraints, indexes, triggers.
-- Run migrations in order on a fresh Supabase project (SQL editor or `supabase db push`).

create extension if not exists citext   with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;    -- helpers live here; this schema is NOT exposed through the API

-- People. One row per person. auth_user_id is null for legacy accounts that have not been claimed yet.
create table public.profiles (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  username     extensions.citext not null unique,
  claim_hash   text,                    -- sha256 of a one-time claim code (legacy accounts only)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint username_format check (username::text ~ '^[A-Za-z0-9][A-Za-z0-9 ''.\-]{0,29}$'),
  constraint claim_only_when_unclaimed check (claim_hash is null or auth_user_id is null)
);

create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  invite_code text not null unique check (invite_code ~ '^[A-Z2-9]{6,8}$'),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.group_members (
  group_id   uuid not null references public.groups(id)   on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (group_id, profile_id)
);
create index group_members_profile_idx on public.group_members (profile_id);

-- One wish list per person (owner_id). A gift is a "surprise gift" when someone other than the owner created it.
create table public.gifts (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  name       text not null check (char_length(btrim(name)) between 1 and 200),
  price      numeric(10,2) check (price is null or price >= 0),
  link       text check (link is null or char_length(link) <= 1000),
  notes      text check (notes is null or char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index gifts_owner_idx on public.gifts (owner_id);

-- "Bought" marks live in their own table so the database can hide them from the list owner.
create table public.purchases (
  gift_id   uuid primary key references public.gifts(id) on delete cascade,
  bought_by uuid references public.profiles(id) on delete set null,
  bought_at timestamptz not null default now()
);

-- Used only by SECURITY DEFINER functions to throttle guessable actions.
create table public.rate_events (
  id      bigint generated always as identity primary key,
  user_id uuid not null,
  kind    text not null,
  at      timestamptz not null default now()
);
create index rate_events_lookup_idx on public.rate_events (user_id, kind, at);

-- Triggers ------------------------------------------------------------------

create function private.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute function private.touch_updated_at();

-- Browser users cannot forge created_by, and nobody can change ownership afterwards.
create function private.gifts_before_write() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.created_by := private.me(); end if;   -- service-role imports may set it
  else
    if new.owner_id is distinct from old.owner_id or new.created_by is distinct from old.created_by then
      raise exception 'Ownership cannot be changed.';
    end if;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger gifts_before_write before insert or update on public.gifts for each row execute function private.gifts_before_write();

-- A surprise gift is bought by definition: record that, without giving the creator any right to touch purchases.
create function private.gifts_after_insert() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.created_by is distinct from new.owner_id then
    insert into public.purchases (gift_id, bought_by) values (new.id, new.created_by) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger gifts_after_insert after insert on public.gifts for each row execute function private.gifts_after_insert();

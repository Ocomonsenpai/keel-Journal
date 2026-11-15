-- Tapebook database schema for Supabase (Postgres).
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Every table is protected by row level security: a signed-in user can only
-- read and change their own rows.

create extension if not exists pgcrypto;

-- Trading accounts (e.g. "Main account", "Prop eval") with starting balances.
create table if not exists public.accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  start_balance numeric(14, 2) not null default 0 check (start_balance >= 0),
  created_at    timestamptz not null default now()
);

-- One row per trade in the journal.
create table if not exists public.trades (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account     text not null,
  pair        text not null check (char_length(pair) between 1 and 24),
  trade_date  date not null,
  trade_time  text,
  direction   text not null check (direction in ('Long', 'Short')),
  session     text not null check (session in ('London', 'New York', 'Tokyo')),
  strategy    text not null,
  status      text not null check (status in ('Win', 'Loss', 'BE')),
  risk        numeric(14, 2) not null check (risk > 0),
  pl          numeric(14, 2) not null,
  mistakes    text[] not null default '{}',
  note        text not null default '',
  screenshots text[] not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists trades_user_date_idx on public.trades (user_id, trade_date);

-- Small per-user documents: trading plan fields, limits, routine history.
create table if not exists public.user_kv (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key        text not null check (key in ('plan', 'limits', 'never', 'routine')),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.accounts enable row level security;
alter table public.trades   enable row level security;
alter table public.user_kv  enable row level security;

drop policy if exists "Own accounts" on public.accounts;
create policy "Own accounts" on public.accounts for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Own trades" on public.trades;
create policy "Own trades" on public.trades for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Own settings" on public.user_kv;
create policy "Own settings" on public.user_kv for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Trade screenshots (storage bucket + policies) live in 002_screenshots.sql; run it after this file.

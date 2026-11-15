-- Keel: trade screenshots. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once.

-- 1. Each trade keeps a list of storage paths for its screenshots.
alter table public.trades add column if not exists screenshots text[] not null default '{}';

-- 2. A private bucket for the images (5 MB per file, images only).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trade-screenshots', 'trade-screenshots', false, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- 3. Each user can only see, add and delete files inside their own folder (<user id>/...).
drop policy if exists "Own screenshots: read" on storage.objects;
create policy "Own screenshots: read" on storage.objects for select to authenticated
  using (bucket_id = 'trade-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Own screenshots: upload" on storage.objects;
create policy "Own screenshots: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'trade-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Own screenshots: delete" on storage.objects;
create policy "Own screenshots: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'trade-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);

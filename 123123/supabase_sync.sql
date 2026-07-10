-- 在 Supabase SQL Editor 中执行本文件一次，即可开启全站数据同步
-- Dashboard → SQL → New query → 粘贴执行

create table if not exists public.app_kv (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_kv enable row level security;

-- 开发阶段：允许匿名密钥读写（后续可按角色收紧）
drop policy if exists "app_kv_anon_all" on public.app_kv;
create policy "app_kv_anon_all"
  on public.app_kv
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- 可选：共享文件二进制（若要用 Storage，请在 Storage 里新建 public bucket: shared-files）
-- 这里只保证元数据同步；大文件建议走 Storage

notify pgrst, 'reload schema';

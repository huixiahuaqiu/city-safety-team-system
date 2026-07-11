-- 标注数据集云端共享：在 Supabase SQL Editor 执行一次
-- 作用：创建公共桶 annotations，并允许团队成员用 publishable key 上传/下载

insert into storage.buckets (id, name, public, file_size_limit)
values ('annotations', 'annotations', true, 209715200)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "annotations_public_read" on storage.objects;
drop policy if exists "annotations_public_insert" on storage.objects;
drop policy if exists "annotations_public_update" on storage.objects;
drop policy if exists "annotations_public_delete" on storage.objects;

create policy "annotations_public_read"
on storage.objects for select
using (bucket_id = 'annotations');

create policy "annotations_public_insert"
on storage.objects for insert
with check (bucket_id = 'annotations');

create policy "annotations_public_update"
on storage.objects for update
using (bucket_id = 'annotations')
with check (bucket_id = 'annotations');

create policy "annotations_public_delete"
on storage.objects for delete
using (bucket_id = 'annotations');

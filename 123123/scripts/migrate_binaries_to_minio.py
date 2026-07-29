# -*- coding: utf-8 -*-
"""把存量本地二进制（共享文件 / 数据集 / 标注）迁移到 MinIO 对象存储。

用法（在 123123 目录、装有 minio 的 Python 环境下执行）：

    python scripts/migrate_binaries_to_minio.py --dry-run   # 只报告，不动数据
    python scripts/migrate_binaries_to_minio.py             # 上传并回写注册表
    python scripts/migrate_binaries_to_minio.py --purge-local
        # 上传成功后删除共享/数据集的本地副本（标注保留为热缓存）

幂等：storage 已是 minio 的条目自动跳过；标注对象上传前先 stat 去重。
服务器迁移时只需搬 MinIO 数据卷 + PostgreSQL，uploads\\ 目录仅剩缓存。
"""

from __future__ import annotations

import argparse
import os
import sys

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import working_proxy as gateway  # noqa: E402


def _object_key_from_saved_as(prefix, saved_as, path):
    """尽量沿用线上命名习惯：files/202607/xx.zip -> {prefix}/202607/xx.zip。"""
    rel = str(saved_as or '').replace('\\', '/')
    parts = [p for p in rel.split('/') if p]
    if len(parts) >= 2 and parts[0] == 'files':
        return '%s/%s' % (prefix, '/'.join(parts[1:]))
    return '%s/migrated/%s' % (prefix, os.path.basename(path))


def migrate_shared(client, dry_run, purge_local):
    moved = skipped = missing = 0
    reg = gateway._shared_registry_load()
    for file_id, meta in sorted((reg.get('files') or {}).items()):
        if meta.get('storage') == 'minio' and meta.get('objectKey'):
            skipped += 1
            continue
        path = meta.get('path') or ''
        if not path or not os.path.isfile(path):
            missing += 1
            print('[shared] MISSING %s (%s)' % (file_id, path))
            continue
        object_key = _object_key_from_saved_as('shared', meta.get('savedAs'), path)
        print('[shared] %s -> %s (%s bytes)%s' % (
            file_id, object_key, os.path.getsize(path), ' [dry-run]' if dry_run else ''
        ))
        if dry_run:
            moved += 1
            continue
        client.fput_object(
            gateway.MINIO_BUCKET,
            object_key,
            path,
            content_type='application/octet-stream',
            part_size=gateway.DATASET_MINIO_PART_SIZE,
        )

        def _mutate(registry, fid=file_id, key=object_key, local=path):
            entry = (registry.get('files') or {}).get(fid)
            if not isinstance(entry, dict):
                return
            entry['storage'] = 'minio'
            entry['objectKey'] = key
            entry['bucket'] = gateway.MINIO_BUCKET
            entry['savedAs'] = key
            entry['path'] = ''
            registry['files'][fid] = entry

        with gateway._shared_registry_lock:
            registry = gateway._shared_registry_load()
            _mutate(registry)
            gateway._shared_registry_save(registry)
        if purge_local:
            try:
                os.remove(path)
            except OSError:
                pass
        moved += 1
    return moved, skipped, missing


def migrate_datasets(client, dry_run, purge_local):
    moved = skipped = missing = 0
    reg = gateway._dataset_registry_load()
    for file_id, meta in sorted((reg.get('files') or {}).items()):
        if meta.get('storage') == 'minio' and meta.get('objectKey'):
            skipped += 1
            continue
        path = meta.get('path') or ''
        if not path or not os.path.isfile(path):
            missing += 1
            print('[dataset] MISSING %s (%s)' % (file_id, path))
            continue
        created = str(meta.get('createdAt') or '')
        month = created[:7].replace('-', '') if len(created) >= 7 else 'migrated'
        object_key = 'datasets/%s/%s' % (month, os.path.basename(path))
        print('[dataset] %s -> %s (%s bytes)%s' % (
            file_id, object_key, os.path.getsize(path), ' [dry-run]' if dry_run else ''
        ))
        if dry_run:
            moved += 1
            continue
        client.fput_object(
            gateway.MINIO_BUCKET,
            object_key,
            path,
            content_type='application/octet-stream',
            part_size=gateway.DATASET_MINIO_PART_SIZE,
        )

        def _mutate(registry, fid=file_id, key=object_key):
            entry = (registry.get('files') or {}).get(fid)
            if not isinstance(entry, dict):
                return
            entry['storage'] = 'minio'
            entry['objectKey'] = key
            entry['bucket'] = gateway.MINIO_BUCKET
            entry['savedAs'] = key
            entry['path'] = ''
            registry['files'][fid] = entry

        gateway._dataset_registry_update(_mutate)
        if purge_local:
            try:
                os.remove(path)
            except OSError:
                pass
        moved += 1
    return moved, skipped, missing


def migrate_annotations(client, dry_run):
    moved = skipped = 0
    root = gateway.ANNOTATION_UPLOAD_ROOT
    if not os.path.isdir(root):
        return 0, 0
    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace('\\', '/')
            object_key = 'annotations/' + rel
            try:
                client.stat_object(gateway.MINIO_BUCKET, object_key)
                skipped += 1
                continue
            except Exception:
                pass
            print('[annotation] %s -> %s%s' % (rel, object_key, ' [dry-run]' if dry_run else ''))
            if not dry_run:
                client.fput_object(
                    gateway.MINIO_BUCKET,
                    object_key,
                    full,
                    content_type='application/octet-stream',
                )
            moved += 1
    return moved, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='只报告将要迁移的内容，不做任何修改')
    parser.add_argument(
        '--purge-local',
        action='store_true',
        help='共享文件/数据集上传成功后删除本地副本（标注一律保留为热缓存）',
    )
    args = parser.parse_args()

    client = gateway._get_minio_client()
    if not client:
        print('错误：MinIO 客户端不可用。请确认 .env 中 SHARED_STORAGE_BACKEND/'
              'DATASET_STORAGE_BACKEND=minio 且 MINIO_* 配置完整、服务已启动。')
        return 2

    shared = migrate_shared(client, args.dry_run, args.purge_local)
    datasets = migrate_datasets(client, args.dry_run, args.purge_local)
    annotations = migrate_annotations(client, args.dry_run)

    print()
    print('共享文件: 迁移 %s / 已在云端 %s / 本地缺失 %s' % shared)
    print('数据集  : 迁移 %s / 已在云端 %s / 本地缺失 %s' % datasets)
    print('标注    : 迁移 %s / 已在云端 %s' % annotations)
    if args.dry_run:
        print('（dry-run 模式：未做任何修改）')
    return 0


if __name__ == '__main__':
    sys.exit(main())

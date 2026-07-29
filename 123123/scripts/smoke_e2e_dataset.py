# -*- coding: utf-8 -*-
"""容器内端到端冒烟：数据集分片上传 -> MinIO 落库 -> 回读校验 -> 清理。"""
import hashlib
import sys

import working_proxy as gw

content = b"name,value\nsmoke,1\n"
md5 = hashlib.md5(content).hexdigest()

info = gw.init_dataset_upload(
    {"uploadId": "smoke-e2e", "fileName": "smoke.csv", "size": len(content),
     "md5": md5, "chunkSize": gw.DATASET_CHUNK_SIZE},
    actor="smoke", role="admin",
)
print("INIT", info.get("totalChunks"))
gw.save_dataset_chunk("smoke-e2e", 0, content, total_chunks=1, actor="smoke", role="admin")
done = gw.complete_dataset_upload({"uploadId": "smoke-e2e", "fileId": "smoke-e2e-file"}, actor="smoke", role="admin")
print("COMPLETE storage=%s savedAs=%s" % (done.get("storage"), done.get("savedAs")))
assert done.get("storage") == "minio", "expected storage=minio"

meta = gw.get_dataset_file_meta("smoke-e2e-file")
client = gw._get_minio_client()
resp = client.get_object(gw.MINIO_BUCKET, meta["objectKey"])
try:
    roundtrip = resp.read()
finally:
    resp.close()
    resp.release_conn()
assert hashlib.md5(roundtrip).hexdigest() == md5, "roundtrip md5 mismatch"
print("ROUNDTRIP ok bytes=%d md5Match=True" % len(roundtrip))

# 清理冒烟数据：MinIO 对象 + 注册表条目
client.remove_object(gw.MINIO_BUCKET, meta["objectKey"])


def _cleanup(reg):
    (reg.get("files") or {}).pop("smoke-e2e-file", None)


gw._dataset_registry_update(_cleanup)
print("CLEANUP done")
print("E2E SMOKE PASSED")
sys.exit(0)

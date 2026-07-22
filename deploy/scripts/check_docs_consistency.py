#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""部署文档 ↔ 代码一致性校验（零依赖，仅标准库）。

作为 CI 卡点，防止“文档写的接口 / 环境变量与网关实际实现脱节”。
校验项：
  1) 文档（DEPLOYMENT.md / deploy/README.md / deploy/RUNBOOK.md 等）中出现的 /api/ 接口，
     必须在 working_proxy.py 里有对应的路由处理（path == / path.startswith）。
  2) deploy/.env.production.example 中形如大写下划线的配置键，
     若在网关代码中完全未被引用则告警（warn，不阻断——部分键供脚本 / Nginx 使用）。

用法：
    python deploy/scripts/check_docs_consistency.py           # 有不一致 → 退出码 1
    python deploy/scripts/check_docs_consistency.py --warn    # 仅告警，总是退出 0
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
GATEWAY = os.path.join(REPO, "123123", "working_proxy.py")
ENV_EXAMPLE = os.path.join(REPO, "deploy", ".env.production.example")
DOCS = [
    os.path.join(REPO, "DEPLOYMENT.md"),
    os.path.join(REPO, "deploy", "README.md"),
    os.path.join(REPO, "deploy", "RUNBOOK.md"),
]

API_RE = re.compile(r"/api/[A-Za-z0-9_\-/]+")
ENV_KEY_RE = re.compile(r"^([A-Z][A-Z0-9_]{2,})=", re.M)


def _read(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def check_endpoints():
    code = _read(GATEWAY)
    # 收集网关实现里出现的 /api 前缀（startswith / == 的字面量）
    impl = set(m.rstrip("/") for m in API_RE.findall(code))
    missing = []
    seen = set()
    for doc in DOCS:
        text = _read(doc)
        for ref in API_RE.findall(text):
            ref = ref.rstrip("/")
            if ref in seen:
                continue
            seen.add(ref)
            # 文档端点只要是某个已实现前缀的前缀或相等即视为覆盖
            ok = any(ref == impl_p or ref.startswith(impl_p) or impl_p.startswith(ref) for impl_p in impl)
            if not ok:
                missing.append((os.path.basename(doc), ref))
    return missing


def check_env_keys():
    env_text = _read(ENV_EXAMPLE)
    code = _read(GATEWAY)
    unused = []
    for key in sorted(set(ENV_KEY_RE.findall(env_text))):
        # 备份 / Nginx / MinIO 服务端专用键不在网关代码里引用，跳过告警
        if key.startswith(("BACKUP_", "DISK_", "HEALTH_", "MINIO_ROOT")):
            continue
        if key not in code:
            unused.append(key)
    return unused


def main(argv):
    warn_only = "--warn" in argv
    missing = check_endpoints()
    unused = check_env_keys()

    if missing:
        print("[check-docs] 文档引用了未实现的接口：")
        for doc, ref in missing:
            print(f"    - {doc}: {ref}")
    else:
        print("[check-docs] 接口一致性 OK：文档中的 /api 端点均可在网关找到实现")

    if unused:
        print("[check-docs] 警告：以下 .env 键未被网关代码引用（可能供脚本 / Nginx 使用）：")
        for key in unused:
            print(f"    - {key}")

    if missing and not warn_only:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

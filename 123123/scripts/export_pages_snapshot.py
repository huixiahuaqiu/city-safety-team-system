#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Export Docker app_sync (+ safe account stub) into a GitHub Pages snapshot JSON."""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parent
ENV_FILE = REPO / "deploy" / "env" / ".env.local"
OUT = ROOT / "data" / "pages-snapshot.json"

# Do not publish audit / crypto material on a public static site.
SKIP_KEYS = {
    "loginLogData",
    "operationLogData",
    "cloudSyncFingerprints",
    "cloudSyncOutbox",
    "backupData",
    "autoBackupConfig",
}
PASSWORD_FIELDS = {
    "password",
    "passwordHash",
    "passwordSalt",
    "passwordIterations",
    "passwordScheme",
    "passwordUpdatedAt",
    "pwdHash",
    "verifier",
}


def load_env() -> dict:
    vars_: dict[str, str] = {}
    if not ENV_FILE.is_file():
        return vars_
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        vars_[k.strip()] = v.strip()
    return vars_


def docker_psql_json(sql: str, user: str, db: str, password: str) -> list:
    proc = subprocess.run(
        [
            "docker",
            "exec",
            "-e",
            f"PGPASSWORD={password}",
            "citysafe-local-db-1",
            "psql",
            "-U",
            user,
            "-d",
            db,
            "-tAc",
            sql,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout or "psql failed")
    text = (proc.stdout or "").strip()
    if not text:
        return []
    # -tAc with json_agg returns one JSON value
    return json.loads(text)


def scrub_value(key: str, value):
    if key == "accountData" and isinstance(value, list):
        cleaned = []
        for row in value:
            if not isinstance(row, dict):
                continue
            item = {k: v for k, v in row.items() if k not in PASSWORD_FIELDS}
            # Drop huge inline avatars from the public snapshot.
            av = item.get("avatar")
            if isinstance(av, str) and av.startswith("data:") and len(av) > 4096:
                item["avatar"] = ""
            # Force demo-friendly local login on Pages.
            item["mustChangePwd"] = False
            item["loginFailCount"] = 0
            item["lockedUntil"] = None
            cleaned.append(item)
        return cleaned
    if key == "teamMemberData" and isinstance(value, list):
        cleaned = []
        for row in value:
            if not isinstance(row, dict):
                continue
            item = dict(row)
            av = item.get("avatar")
            if isinstance(av, str) and av.startswith("data:") and len(av) > 4096:
                item["avatar"] = ""
            cleaned.append(item)
        return cleaned
    return value


def main() -> int:
    env = load_env()
    user = env.get("POSTGRES_USER", "citysafe")
    db = env.get("POSTGRES_DB", "citysafe")
    password = env.get("POSTGRES_PASSWORD") or env.get("PGPASSWORD", "")
    if not password:
        print("ERROR: missing POSTGRES_PASSWORD in deploy/env/.env.local", file=sys.stderr)
        return 1

    rows = docker_psql_json(
        "SELECT COALESCE(json_agg(json_build_object('key', sync_key, 'value', value) "
        "ORDER BY sync_key), '[]'::json) FROM app_sync;",
        user,
        db,
        password,
    )
    data = {}
    for row in rows:
        key = row.get("key")
        if not key or key in SKIP_KEYS:
            continue
        data[key] = scrub_value(key, row.get("value"))

    # Prefer richer account list from local recovery backup when present (already scrubbed).
    recovery = ROOT / "_recovery" / "merged-team-backup.json"
    if recovery.is_file():
        try:
            backup = json.loads(recovery.read_text(encoding="utf-8"))
            raw_acc = (backup.get("data") or {}).get("accountData")
            if raw_acc:
                acc = json.loads(raw_acc) if isinstance(raw_acc, str) else raw_acc
                if isinstance(acc, list) and len(acc) > len(data.get("accountData") or []):
                    data["accountData"] = scrub_value("accountData", acc)
        except Exception as exc:
            print("WARN: recovery account merge skipped:", exc)

    # Pages 无网关：演示明文密码 + 跳过强制改密（静态站改密无后端）。
    if isinstance(data.get("accountData"), list):
        for row in data["accountData"]:
            if isinstance(row, dict):
                row["password"] = "123456"
                row["mustChangePwd"] = False
                row["firstLogin"] = False

    version = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    payload = {
        "meta": {
            "type": "citysafe-pages-snapshot",
            "version": version,
            "exportedAt": datetime.now(timezone.utc).isoformat(),
            "note": "GitHub Pages 静态演示快照（只读展示；登录用演示密码 123456）",
            "keyCount": len(data),
        },
        "data": data,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"[export_pages_snapshot] wrote {OUT} ({OUT.stat().st_size} bytes, {len(data)} keys, v={version})")
    team = data.get("teamMemberData") or []
    papers = data.get("paperData") or []
    patents = data.get("patentData") or []
    print(f"  team={len(team) if isinstance(team, list) else '?'} paper={len(papers) if isinstance(papers, list) else '?'} patent={len(patents) if isinstance(patents, list) else '?'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

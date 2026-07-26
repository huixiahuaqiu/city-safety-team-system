#!/usr/bin/env python3
"""Run a readiness check and an optional authenticated gateway smoke test."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Callable, Mapping, Sequence
import urllib.error
import urllib.parse
import urllib.request


MAX_RESPONSE_BYTES = 1024 * 1024


class SmokeError(RuntimeError):
    """Raised when a smoke-test assertion fails."""


def normalize_base_url(value: str) -> str:
    value = str(value or "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise SmokeError("--base-url must be an absolute http:// or https:// URL")
    if parsed.username or parsed.password:
        raise SmokeError("--base-url must not contain credentials")
    if parsed.query or parsed.fragment:
        raise SmokeError("--base-url must not contain a query string or fragment")
    return value


def _response_message(raw: bytes) -> str:
    if not raw:
        return ""
    text = raw.decode("utf-8", errors="replace")
    text = " ".join(text.split())
    return text[:300]


def request_json(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: Mapping[str, Any] | None = None,
    token: str | None = None,
    timeout: float = 10,
) -> dict[str, Any]:
    url = base_url + path
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        data=body,
        headers=headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(request, timeout=max(0.1, timeout)) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            status = getattr(response, "status", 200)
    except urllib.error.HTTPError as exc:
        raw = exc.read(MAX_RESPONSE_BYTES + 1)
        detail = _response_message(raw)
        suffix = f": {detail}" if detail else ""
        raise SmokeError(f"{method} {path} returned HTTP {exc.code}{suffix}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SmokeError(
            f"{method} {path} could not connect ({type(exc).__name__})"
        ) from exc

    if status < 200 or status >= 300:
        raise SmokeError(f"{method} {path} returned HTTP {status}")
    if len(raw) > MAX_RESPONSE_BYTES:
        raise SmokeError(f"{method} {path} response exceeded 1 MiB")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SmokeError(f"{method} {path} did not return valid JSON") from exc
    if not isinstance(value, dict):
        raise SmokeError(f"{method} {path} JSON response must be an object")
    return value


def wait_for_readiness(
    base_url: str,
    *,
    wait_seconds: float = 60,
    poll_interval: float = 2,
    timeout: float = 10,
    requester: Callable[..., dict[str, Any]] = request_json,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    deadline = monotonic() + max(0.0, wait_seconds)
    last_reason = "health endpoint was not checked"

    while True:
        try:
            health = requester(base_url, "/api/health", timeout=timeout)
            if health.get("ok") is not True:
                last_reason = "health.ok is not true"
            elif health.get("ready") is not True:
                last_reason = "health.ready is not true"
            elif health.get("degraded") is True:
                last_reason = "health.degraded is true"
            else:
                return health
        except SmokeError as exc:
            last_reason = str(exc)

        if monotonic() >= deadline:
            raise SmokeError(f"readiness timed out: {last_reason}")
        remaining = max(0.0, deadline - monotonic())
        sleep(min(max(0.0, poll_interval), remaining))


def run_smoke(
    base_url: str,
    *,
    username: str | None = None,
    password: str | None = None,
    wait_seconds: float = 60,
    poll_interval: float = 2,
    timeout: float = 10,
    requester: Callable[..., dict[str, Any]] = request_json,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    base_url = normalize_base_url(base_url)
    username = str(username or "").strip()
    password = str(password or "")
    if bool(username) != bool(password):
        raise SmokeError("username and password must be provided together")

    health = wait_for_readiness(
        base_url,
        wait_seconds=wait_seconds,
        poll_interval=poll_interval,
        timeout=timeout,
        requester=requester,
    )
    log("[smoke] health/readiness OK")

    result: dict[str, Any] = {"health": health}
    if not username:
        return result

    login = requester(
        base_url,
        "/api/auth/login",
        method="POST",
        payload={"username": username, "password": password},
        timeout=timeout,
    )
    token = login.get("token")
    login_user = login.get("user")
    if login.get("ok") is not True or not isinstance(token, str) or not token:
        raise SmokeError("login response did not contain a valid session token")
    if not isinstance(login_user, dict):
        raise SmokeError("login response did not contain a user object")

    me = requester(
        base_url,
        "/api/auth/me",
        token=token,
        timeout=timeout,
    )
    me_user = me.get("user")
    if me.get("ok") is not True or not isinstance(me_user, dict):
        raise SmokeError("/api/auth/me did not validate the session")
    if login_user.get("id") is not None and str(login_user.get("id")) != str(
        me_user.get("id")
    ):
        raise SmokeError("login identity does not match /api/auth/me")

    log("[smoke] authenticated session OK")
    result.update({"login": login, "me": me})
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default=os.environ.get("SMOKE_BASE_URL") or "http://127.0.0.1:8000",
    )
    parser.add_argument("--username", default=os.environ.get("SMOKE_USERNAME"))
    parser.add_argument("--password", default=os.environ.get("SMOKE_PASSWORD"))
    parser.add_argument(
        "--wait-seconds",
        type=float,
        default=float(os.environ.get("SMOKE_WAIT_SECONDS") or 60),
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=float(os.environ.get("SMOKE_POLL_INTERVAL") or 2),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.environ.get("SMOKE_REQUEST_TIMEOUT") or 10),
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        run_smoke(
            args.base_url,
            username=args.username,
            password=args.password,
            wait_seconds=args.wait_seconds,
            poll_interval=args.poll_interval,
            timeout=args.timeout,
        )
        print("[smoke] PASS")
        return 0
    except SmokeError as exc:
        print(f"[smoke] FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""PostgreSQL persistence primitives for the City Safety Team System.

The module deliberately imports psycopg only when a database operation is
performed.  This keeps static-file and unit-test workflows usable without a
PostgreSQL driver while producing an actionable error when DATABASE_URL is
configured but psycopg 3 is missing.

All public mutation helpers execute in a single database transaction.  Sync
values use compare-and-swap semantics:

* ``base_version == 0`` creates a value only when it does not already exist.
* ``base_version > 0`` updates only the row with that exact version.

Callers must fetch the current version and explicitly resolve a
``VersionConflict`` instead of silently overwriting another user's update.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime
import importlib
import json
import os
import re
from typing import Any, Iterable, Mapping, Sequence


class DataStoreError(RuntimeError):
    """Base class for storage-layer failures with safe user-facing messages."""


class DatabaseNotConfigured(DataStoreError):
    """Raised when a database operation is attempted without DATABASE_URL."""


class DatabaseDriverUnavailable(DataStoreError):
    """Raised when DATABASE_URL is set but psycopg 3 is not installed."""


class VersionConflict(DataStoreError):
    """Raised when a sync compare-and-swap operation uses a stale version."""

    def __init__(
        self,
        sync_key: str,
        expected_version: int,
        current_version: int | None,
    ) -> None:
        self.sync_key = sync_key
        self.expected_version = expected_version
        self.current_version = current_version
        current = "missing" if current_version is None else str(current_version)
        super().__init__(
            f"sync value version conflict for {sync_key!r}: "
            f"expected {expected_version}, current {current}"
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "error": "version_conflict",
            "syncKey": self.sync_key,
            "expectedVersion": self.expected_version,
            "currentVersion": self.current_version,
        }


class RecordVersionConflict(DataStoreError):
    """Raised when one or more record mutations use stale row versions."""

    def __init__(
        self,
        record_type: str,
        expected_versions: Mapping[int, int],
        current_versions: Mapping[int, int],
    ) -> None:
        self.record_type = record_type
        self.expected_versions = dict(expected_versions)
        self.current_versions = dict(current_versions)
        super().__init__(f"record version conflict for {record_type!r}")

    def as_dict(self) -> dict[str, Any]:
        return {
            "error": "record_version_conflict",
            "recordType": self.record_type,
            "expectedVersions": {
                str(key): value for key, value in self.expected_versions.items()
            },
            "currentVersions": {
                str(key): value for key, value in self.current_versions.items()
            },
        }


_SYNC_KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
_RECORD_TYPE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,79}$")
_MAX_ACTOR_LENGTH = 200
_MAX_ACCOUNT_KEY_LENGTH = 200
_MAX_SYNC_KEYS_PER_QUERY = 500
_MAX_RECORD_IDS_PER_QUERY = 1_000
_MAX_RECORD_PAGE_SIZE = 1_000
_RECORD_ORDER_COLUMNS = {
    "id": "id",
    "version": "version",
    "created_at": "created_at",
    "updated_at": "updated_at",
}


def database_enabled() -> bool:
    """Return whether PostgreSQL connection settings are configured."""

    return bool(
        (os.environ.get("DATABASE_URL") or "").strip()
        or (os.environ.get("PGHOST") or "").strip()
    )


def _database_url() -> str:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        raise DatabaseNotConfigured(
            "PostgreSQL is not configured; set DATABASE_URL before using "
            "the data store"
        )
    return url


def _connection_settings() -> tuple[tuple[Any, ...], dict[str, Any]]:
    """Build psycopg connection arguments from URL or standard PG* variables."""

    url = (os.environ.get("DATABASE_URL") or "").strip()
    if url:
        return (url,), {}

    host = (os.environ.get("PGHOST") or "").strip()
    if not host:
        raise DatabaseNotConfigured(
            "PostgreSQL is not configured; set DATABASE_URL or PGHOST and the "
            "standard PG* variables before using the data store"
        )
    settings: dict[str, Any] = {"host": host}
    for env_name, argument_name in (
        ("PGPORT", "port"),
        ("PGDATABASE", "dbname"),
        ("PGUSER", "user"),
        ("PGPASSWORD", "password"),
    ):
        value = (os.environ.get(env_name) or "").strip()
        if value:
            settings[argument_name] = value
    return (), settings


def _load_psycopg():
    try:
        return importlib.import_module("psycopg")
    except ModuleNotFoundError as exc:
        if exc.name != "psycopg":
            raise
        raise DatabaseDriverUnavailable(
            "PostgreSQL support requires psycopg 3. Install it with "
            "'python -m pip install \"psycopg[binary]>=3,<4\"'."
        ) from exc


def _connect_timeout() -> int:
    raw = (os.environ.get("DATABASE_CONNECT_TIMEOUT_SECONDS") or "5").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 5
    return max(1, min(value, 60))


@contextmanager
def _connection():
    """Yield a transaction-scoped psycopg connection.

    psycopg's connection context commits on success and rolls back on any
    exception, including ``VersionConflict``.
    """

    psycopg = _load_psycopg()
    positional, keyword = _connection_settings()
    with psycopg.connect(
        *positional,
        **keyword,
        connect_timeout=_connect_timeout(),
        application_name="citysafe-gateway",
    ) as connection:
        yield connection


def healthcheck() -> bool:
    """Check that PostgreSQL is reachable and can execute a trivial query.

    An unconfigured database returns ``False``.  A configured database with a
    missing driver raises ``DatabaseDriverUnavailable`` with install guidance;
    connection errors are intentionally allowed to reach the caller so health
    endpoints can distinguish configuration from availability failures.
    """

    if not database_enabled():
        return False
    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            row = cursor.fetchone()
    return bool(row and row[0] == 1)


def _validate_sync_key(sync_key: str) -> str:
    key = str(sync_key or "").strip()
    if not _SYNC_KEY_RE.fullmatch(key):
        raise ValueError(
            "sync_key must be 1-120 characters using letters, numbers, "
            "dot, colon, underscore or hyphen"
        )
    return key


def _validate_record_type(record_type: str) -> str:
    value = str(record_type or "").strip()
    if not _RECORD_TYPE_RE.fullmatch(value):
        raise ValueError(
            "record_type must start with a letter and contain only letters, "
            "numbers, dot, colon, underscore or hyphen"
        )
    return value


def _validate_actor(actor: str) -> str:
    value = str(actor or "").strip()
    if not value or len(value) > _MAX_ACTOR_LENGTH:
        raise ValueError(f"actor must contain 1-{_MAX_ACTOR_LENGTH} characters")
    return value


def _validate_mapping(value: Mapping[str, Any], field_name: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{field_name} must be a JSON object")
    return dict(value)


def _json_text(value: Any, field_name: str = "value") -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be valid finite JSON") from exc


def _iso(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _validate_expected_versions(
    expected_versions: Mapping[int, int] | None,
) -> dict[int, int] | None:
    if expected_versions is None:
        return None
    if not isinstance(expected_versions, Mapping) or not expected_versions:
        raise ValueError("expected_versions must be a non-empty mapping")
    normalized: dict[int, int] = {}
    for raw_id, raw_version in expected_versions.items():
        if isinstance(raw_id, bool) or isinstance(raw_version, bool):
            raise ValueError("record ids and versions must be positive integers")
        record_id = int(raw_id)
        version = int(raw_version)
        if record_id <= 0 or version <= 0:
            raise ValueError("record ids and versions must be positive integers")
        normalized[record_id] = version
    if len(normalized) > _MAX_RECORD_IDS_PER_QUERY:
        raise ValueError(
            f"at most {_MAX_RECORD_IDS_PER_QUERY} expected versions may be supplied"
        )
    return normalized


def _record_version_clause(
    expected_versions: Mapping[int, int] | None,
) -> tuple[str, list[Any]]:
    normalized = _validate_expected_versions(expected_versions)
    if normalized is None:
        return "", []
    clauses: list[str] = []
    params: list[Any] = []
    for record_id, version in normalized.items():
        clauses.append("(id = %s AND version = %s)")
        params.extend((record_id, version))
    return " AND (" + " OR ".join(clauses) + ")", params


def _sync_row(row: Sequence[Any]) -> dict[str, Any]:
    return {
        "syncKey": row[0],
        "value": row[1],
        "version": int(row[2]),
        "updatedAt": _iso(row[3]),
        "updatedBy": row[4],
    }


def list_sync_values(keys: Iterable[str] | None = None) -> list[dict[str, Any]]:
    """Return all sync values or the requested subset."""

    params: list[Any] = []
    where = ""
    if keys is not None:
        if isinstance(keys, (str, bytes)):
            raise TypeError("keys must be an iterable of sync-key strings")
        normalized = list(dict.fromkeys(_validate_sync_key(key) for key in keys))
        if len(normalized) > _MAX_SYNC_KEYS_PER_QUERY:
            raise ValueError(
                f"at most {_MAX_SYNC_KEYS_PER_QUERY} sync keys may be requested"
            )
        if not normalized:
            return []
        where = " WHERE sync_key = ANY(%s)"
        params.append(normalized)

    query = (
        "SELECT sync_key, value, version, updated_at, updated_by "
        f"FROM app_sync{where} ORDER BY sync_key"
    )
    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(query, params)
            rows = cursor.fetchall()
    return [_sync_row(row) for row in rows]


def get_sync_value(sync_key: str) -> dict[str, Any] | None:
    """Return one sync value, or ``None`` when the key does not exist."""

    key = _validate_sync_key(sync_key)
    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT sync_key, value, version, updated_at, updated_by "
                "FROM app_sync WHERE sync_key = %s",
                (key,),
            )
            row = cursor.fetchone()
    return _sync_row(row) if row else None


def put_sync_value(
    sync_key: str,
    value: Any,
    base_version: int,
    actor: str,
) -> dict[str, Any]:
    """Atomically create or update a sync value using compare-and-swap."""

    key = _validate_sync_key(sync_key)
    updated_by = _validate_actor(actor)
    if isinstance(base_version, bool) or not isinstance(base_version, int):
        raise TypeError("base_version must be an integer")
    if base_version < 0:
        raise ValueError("base_version must be zero or greater")
    value_json = _json_text(value)

    with _connection() as connection:
        with connection.cursor() as cursor:
            if base_version == 0:
                cursor.execute(
                    "INSERT INTO app_sync "
                    "(sync_key, value, version, updated_at, updated_by) "
                    "VALUES (%s, %s::jsonb, 1, now(), %s) "
                    "ON CONFLICT (sync_key) DO NOTHING "
                    "RETURNING sync_key, value, version, updated_at, updated_by",
                    (key, value_json, updated_by),
                )
            else:
                cursor.execute(
                    "UPDATE app_sync "
                    "SET value = %s::jsonb, version = version + 1, "
                    "updated_at = now(), updated_by = %s "
                    "WHERE sync_key = %s AND version = %s "
                    "RETURNING sync_key, value, version, updated_at, updated_by",
                    (value_json, updated_by, key, base_version),
                )
            row = cursor.fetchone()
            if row:
                return _sync_row(row)

            cursor.execute(
                "SELECT version FROM app_sync WHERE sync_key = %s",
                (key,),
            )
            current = cursor.fetchone()
            current_version = int(current[0]) if current else None
            raise VersionConflict(key, base_version, current_version)


def _account_key(profile: Mapping[str, Any]) -> str:
    for field in ("studentId", "id", "email"):
        candidate = profile.get(field)
        if candidate is None:
            continue
        value = str(candidate).strip()
        if value:
            if len(value) > _MAX_ACCOUNT_KEY_LENGTH:
                raise ValueError(
                    f"account {field} exceeds {_MAX_ACCOUNT_KEY_LENGTH} characters"
                )
            return value
    raise ValueError("account requires a non-empty studentId, id or email")


def load_accounts() -> list[dict[str, Any]]:
    """Load account profiles in their preserved source order."""

    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT profile FROM app_accounts "
                "ORDER BY ordinal ASC, account_key ASC"
            )
            rows = cursor.fetchall()
    return [row[0] for row in rows]


def replace_accounts(
    accounts: Sequence[Mapping[str, Any]],
    actor: str,
    *,
    allow_empty: bool = False,
) -> int:
    """Atomically replace the account collection.

    Empty replacement is rejected by default to reduce accidental
    administrator lockout.  A controlled migration may opt in explicitly.
    """

    if isinstance(accounts, (str, bytes)) or not isinstance(accounts, Sequence):
        raise TypeError("accounts must be a sequence of JSON objects")
    if not accounts and not allow_empty:
        raise ValueError("refusing to remove every account without allow_empty=True")
    updated_by = _validate_actor(actor)

    prepared: list[tuple[str, str, int, str]] = []
    seen: set[str] = set()
    for ordinal, raw_profile in enumerate(accounts):
        profile = _validate_mapping(raw_profile, "account profile")
        key = _account_key(profile)
        normalized_key = key.casefold()
        if normalized_key in seen:
            raise ValueError(f"duplicate account key: {key}")
        seen.add(normalized_key)
        prepared.append((key, _json_text(profile, "account profile"), ordinal, updated_by))

    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute("LOCK TABLE app_accounts IN SHARE ROW EXCLUSIVE MODE")
            cursor.execute("DELETE FROM app_accounts")
            if prepared:
                cursor.executemany(
                    "INSERT INTO app_accounts "
                    "(account_key, profile, ordinal, updated_at, updated_by) "
                    "VALUES (%s, %s::jsonb, %s, now(), %s)",
                    prepared,
                )
    return len(prepared)


def bootstrap_account(account: Mapping[str, Any], actor: str = "bootstrap") -> bool:
    """Insert the first account only when the account table is empty."""

    profile = _validate_mapping(account, "account")
    key = _account_key(profile)
    updated_by = _validate_actor(actor)
    profile_json = _json_text(profile, "account")

    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute("LOCK TABLE app_accounts IN SHARE ROW EXCLUSIVE MODE")
            cursor.execute("SELECT EXISTS (SELECT 1 FROM app_accounts)")
            row = cursor.fetchone()
            if row and bool(row[0]):
                return False
            cursor.execute(
                "INSERT INTO app_accounts "
                "(account_key, profile, ordinal, updated_at, updated_by) "
                "VALUES (%s, %s::jsonb, 0, now(), %s)",
                (key, profile_json, updated_by),
            )
    return True


def _normalize_record_ids(record_ids: Iterable[int] | None) -> list[int] | None:
    if record_ids is None:
        return None
    if isinstance(record_ids, (str, bytes)):
        raise TypeError("record ids must be an iterable of positive integers")
    normalized: list[int] = []
    for raw_id in record_ids:
        if isinstance(raw_id, bool):
            raise TypeError("record ids must be positive integers")
        try:
            value = int(raw_id)
        except (TypeError, ValueError) as exc:
            raise TypeError("record ids must be positive integers") from exc
        if value <= 0:
            raise ValueError("record ids must be positive integers")
        normalized.append(value)
    normalized = list(dict.fromkeys(normalized))
    if len(normalized) > _MAX_RECORD_IDS_PER_QUERY:
        raise ValueError(
            f"at most {_MAX_RECORD_IDS_PER_QUERY} record ids may be requested"
        )
    return normalized


def _record_where(
    record_type: str,
    *,
    record_ids: Iterable[int] | None = None,
    filters: Mapping[str, Any] | None = None,
    require_selector: bool = False,
) -> tuple[str, list[Any]]:
    kind = _validate_record_type(record_type)
    ids = _normalize_record_ids(record_ids)
    filter_object = None
    if filters is not None:
        filter_object = _validate_mapping(filters, "filters")

    selected = ids is not None or bool(filter_object)
    if require_selector and not selected:
        raise ValueError("record_ids or at least one filter is required")

    clauses = ["record_type = %s"]
    params: list[Any] = [kind]
    if ids is not None:
        if ids:
            clauses.append("id = ANY(%s)")
            params.append(ids)
        else:
            clauses.append("FALSE")
    if filter_object:
        clauses.append("payload @> %s::jsonb")
        params.append(_json_text(filter_object, "filters"))
    return " AND ".join(clauses), params


def _record_row(row: Sequence[Any]) -> dict[str, Any]:
    return {
        "id": int(row[0]),
        "recordType": row[1],
        "payload": row[2],
        "version": int(row[3]),
        "createdAt": _iso(row[4]),
        "updatedAt": _iso(row[5]),
        "createdBy": row[6],
        "updatedBy": row[7],
    }


_RECORD_RETURNING = (
    "id, record_type, payload, version, created_at, updated_at, "
    "created_by, updated_by"
)


def list_records(
    record_type: str,
    *,
    record_ids: Iterable[int] | None = None,
    filters: Mapping[str, Any] | None = None,
    order_by: str = "updated_at",
    descending: bool = True,
    limit: int = 500,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """List generic business records with safe JSON containment filters."""

    where, params = _record_where(
        record_type,
        record_ids=record_ids,
        filters=filters,
    )
    order_column = _RECORD_ORDER_COLUMNS.get(str(order_by))
    if not order_column:
        raise ValueError(
            "order_by must be one of " + ", ".join(sorted(_RECORD_ORDER_COLUMNS))
        )
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise TypeError("limit must be an integer")
    if isinstance(offset, bool) or not isinstance(offset, int):
        raise TypeError("offset must be an integer")
    if not isinstance(descending, bool):
        raise TypeError("descending must be a boolean")
    if limit < 1 or limit > _MAX_RECORD_PAGE_SIZE:
        raise ValueError(f"limit must be between 1 and {_MAX_RECORD_PAGE_SIZE}")
    if offset < 0:
        raise ValueError("offset must be zero or greater")

    direction = "DESC" if descending else "ASC"
    query = (
        f"SELECT {_RECORD_RETURNING} FROM app_records WHERE {where} "
        f"ORDER BY {order_column} {direction}, id {direction} LIMIT %s OFFSET %s"
    )
    params.extend((limit, offset))
    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(query, params)
            rows = cursor.fetchall()
    return [_record_row(row) for row in rows]


def create_record(
    record_type: str,
    payload: Mapping[str, Any],
    actor: str,
) -> dict[str, Any]:
    """Create one generic business record."""

    kind = _validate_record_type(record_type)
    body = _validate_mapping(payload, "payload")
    created_by = _validate_actor(actor)
    body_json = _json_text(body, "payload")

    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO app_records "
                "(record_type, payload, version, created_at, updated_at, "
                "created_by, updated_by) "
                "VALUES (%s, %s::jsonb, 1, now(), now(), %s, %s) "
                f"RETURNING {_RECORD_RETURNING}",
                (kind, body_json, created_by, created_by),
            )
            row = cursor.fetchone()
    if not row:
        raise DataStoreError("record insert completed without returning a row")
    return _record_row(row)


def update_records(
    record_type: str,
    payload: Mapping[str, Any],
    *,
    actor: str,
    record_ids: Iterable[int] | None = None,
    filters: Mapping[str, Any] | None = None,
    replace: bool = False,
    expected_versions: Mapping[int, int] | None = None,
) -> list[dict[str, Any]]:
    """Update selected records, merging JSON by default.

    A selector is mandatory so a malformed request cannot update an entire
    record type accidentally.
    """

    patch = _validate_mapping(payload, "payload")
    if not patch and not replace:
        raise ValueError("payload patch must not be empty")
    updated_by = _validate_actor(actor)
    where, params = _record_where(
        record_type,
        record_ids=record_ids,
        filters=filters,
        require_selector=True,
    )
    normalized_versions = _validate_expected_versions(expected_versions)
    version_clause, version_params = _record_version_clause(normalized_versions)
    if normalized_versions is not None:
        selected_ids = set(_normalize_record_ids(record_ids or normalized_versions.keys()) or [])
        if selected_ids != set(normalized_versions):
            raise ValueError("expected_versions must cover every selected record id")
    payload_expression = "%s::jsonb" if replace else "payload || %s::jsonb"
    query = (
        f"UPDATE app_records SET payload = {payload_expression}, "
        "version = version + 1, updated_at = now(), updated_by = %s "
        f"WHERE {where}{version_clause} RETURNING {_RECORD_RETURNING}"
    )
    query_params = [
        _json_text(patch, "payload"),
        updated_by,
        *params,
        *version_params,
    ]
    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(query, query_params)
            rows = cursor.fetchall()
            if normalized_versions is not None and len(rows) != len(normalized_versions):
                cursor.execute(
                    "SELECT id, version FROM app_records "
                    "WHERE record_type = %s AND id = ANY(%s)",
                    (record_type, list(normalized_versions)),
                )
                current_versions = {
                    int(row[0]): int(row[1]) for row in cursor.fetchall()
                }
                raise RecordVersionConflict(
                    record_type,
                    normalized_versions,
                    current_versions,
                )
    return [_record_row(row) for row in rows]


def delete_records(
    record_type: str,
    *,
    actor: str,
    record_ids: Iterable[int] | None = None,
    filters: Mapping[str, Any] | None = None,
    expected_versions: Mapping[int, int] | None = None,
) -> int:
    """Delete selected records and return the number removed.

    ``actor`` is validated even though deleted rows do not retain it; callers
    should pass the same verified identity to ``append_audit``.
    """

    _validate_actor(actor)
    where, params = _record_where(
        record_type,
        record_ids=record_ids,
        filters=filters,
        require_selector=True,
    )
    normalized_versions = _validate_expected_versions(expected_versions)
    version_clause, version_params = _record_version_clause(normalized_versions)
    if normalized_versions is not None:
        selected_ids = set(_normalize_record_ids(record_ids or normalized_versions.keys()) or [])
        if selected_ids != set(normalized_versions):
            raise ValueError("expected_versions must cover every selected record id")
    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                f"DELETE FROM app_records WHERE {where}{version_clause} RETURNING id",
                [*params, *version_params],
            )
            rows = cursor.fetchall()
            if normalized_versions is not None and len(rows) != len(normalized_versions):
                cursor.execute(
                    "SELECT id, version FROM app_records "
                    "WHERE record_type = %s AND id = ANY(%s)",
                    (record_type, list(normalized_versions)),
                )
                current_versions = {
                    int(row[0]): int(row[1]) for row in cursor.fetchall()
                }
                raise RecordVersionConflict(
                    record_type,
                    normalized_versions,
                    current_versions,
                )
    return len(rows)


def _audit_row(row: Sequence[Any]) -> dict[str, Any]:
    return {
        "id": int(row[0]),
        "eventType": row[1],
        "actor": row[2],
        "subjectType": row[3],
        "subjectId": row[4],
        "details": row[5],
        "createdAt": _iso(row[6]),
    }


def append_audit(
    event_type: str,
    actor: str,
    *,
    subject_type: str | None = None,
    subject_id: str | int | None = None,
    details: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Append an immutable server-side audit event."""

    event = str(event_type or "").strip()
    if not event or len(event) > 120:
        raise ValueError("event_type must contain 1-120 characters")
    verified_actor = _validate_actor(actor)
    normalized_subject_type = (
        str(subject_type).strip() if subject_type is not None else None
    )
    if normalized_subject_type is not None and (
        not normalized_subject_type or len(normalized_subject_type) > 80
    ):
        raise ValueError("subject_type must contain 1-80 characters when provided")
    normalized_subject_id = (
        str(subject_id).strip() if subject_id is not None else None
    )
    if normalized_subject_id is not None and len(normalized_subject_id) > 200:
        raise ValueError("subject_id must not exceed 200 characters")
    detail_object = _validate_mapping({} if details is None else details, "details")
    details_json = _json_text(detail_object, "details")

    with _connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO audit_events "
                "(event_type, actor, subject_type, subject_id, details, created_at) "
                "VALUES (%s, %s, %s, %s, %s::jsonb, now()) "
                "RETURNING id, event_type, actor, subject_type, subject_id, "
                "details, created_at",
                (
                    event,
                    verified_actor,
                    normalized_subject_type,
                    normalized_subject_id,
                    details_json,
                ),
            )
            row = cursor.fetchone()
    if not row:
        raise DataStoreError("audit insert completed without returning a row")
    return _audit_row(row)


__all__ = [
    "DataStoreError",
    "DatabaseNotConfigured",
    "DatabaseDriverUnavailable",
    "VersionConflict",
    "RecordVersionConflict",
    "database_enabled",
    "healthcheck",
    "list_sync_values",
    "get_sync_value",
    "put_sync_value",
    "load_accounts",
    "replace_accounts",
    "bootstrap_account",
    "list_records",
    "create_record",
    "update_records",
    "delete_records",
    "append_audit",
]

#!/usr/bin/env python3
"""Apply ordered PostgreSQL migrations with drift detection.

The default migration directory is ``/opt/citysafe/deploy/db/migrations``.
Set ``DATABASE_URL`` or the standard ``PG*`` connection variables before
running this script.  Psycopg 3 is preferred; psycopg2 is also supported.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import hashlib
import os
from pathlib import Path
import sys
import time
from typing import Any, Callable, Iterable, Mapping, Sequence


DEFAULT_MIGRATIONS_DIR = Path("/opt/citysafe/deploy/db/migrations")
MIGRATION_LOCK_ID = 2_026_072_601


class MigrationError(RuntimeError):
    """Base class for migration failures."""


class MigrationDriftError(MigrationError):
    """Raised when an applied migration file has changed."""


@dataclass(frozen=True)
class ConnectionTarget:
    dsn: str | None = field(default=None, repr=False)
    kwargs: dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class Migration:
    filename: str
    path: Path
    sha256: str
    sql: str = field(repr=False)


def connection_target(environ: Mapping[str, str]) -> ConnectionTarget:
    """Build connection arguments, with DATABASE_URL taking precedence."""
    database_url = str(environ.get("DATABASE_URL") or "").strip()
    if database_url:
        return ConnectionTarget(dsn=database_url)

    mapping = {
        "PGHOST": "host",
        "PGPORT": "port",
        "PGDATABASE": "dbname",
        "PGUSER": "user",
        "PGPASSWORD": "password",
    }
    kwargs: dict[str, Any] = {}
    for env_name, argument_name in mapping.items():
        value = str(environ.get(env_name) or "").strip()
        if value:
            kwargs[argument_name] = value

    if not kwargs:
        raise MigrationError(
            "database connection is not configured; set DATABASE_URL or PGHOST/"
            "PGPORT/PGDATABASE/PGUSER/PGPASSWORD"
        )

    if "port" in kwargs:
        try:
            port = int(kwargs["port"])
        except ValueError as exc:
            raise MigrationError("PGPORT must be an integer") from exc
        if not 1 <= port <= 65535:
            raise MigrationError("PGPORT must be between 1 and 65535")
        kwargs["port"] = port

    return ConnectionTarget(kwargs=kwargs)


def discover_migrations(directory: Path) -> list[Migration]:
    """Read non-empty .sql files in lexicographic filename order."""
    directory = Path(directory)
    if not directory.is_dir():
        raise MigrationError(f"migration directory does not exist: {directory}")

    migrations: list[Migration] = []
    for path in sorted(directory.glob("*.sql"), key=lambda item: item.name):
        if not path.is_file():
            continue
        raw = path.read_bytes()
        if not raw.strip():
            raise MigrationError(f"migration is empty: {path.name}")
        try:
            sql = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise MigrationError(f"migration is not UTF-8: {path.name}") from exc
        migrations.append(
            Migration(
                filename=path.name,
                path=path,
                sha256=hashlib.sha256(raw).hexdigest(),
                sql=sql,
            )
        )
    return migrations


def load_connect_function() -> tuple[Callable[..., Any], str]:
    """Load an installed PostgreSQL driver without importing it at module load."""
    try:
        import psycopg  # type: ignore[import-not-found]

        return psycopg.connect, "psycopg"
    except ImportError:
        try:
            import psycopg2  # type: ignore[import-not-found]

            return psycopg2.connect, "psycopg2"
        except ImportError as exc:
            raise MigrationError(
                "PostgreSQL driver is missing; install psycopg[binary] or psycopg2"
            ) from exc


def _connect_once(
    connect: Callable[..., Any],
    target: ConnectionTarget,
    connect_timeout: int,
) -> Any:
    kwargs = dict(target.kwargs)
    kwargs["connect_timeout"] = max(1, int(connect_timeout))
    if target.dsn is not None:
        return connect(target.dsn, **kwargs)
    return connect(**kwargs)


def wait_for_database(
    connect: Callable[..., Any],
    target: ConnectionTarget,
    *,
    wait_seconds: float = 60,
    poll_interval: float = 2,
    connect_timeout: int = 5,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
    log: Callable[[str], None] = print,
) -> Any:
    """Wait until a connection can execute SELECT 1, then return it."""
    wait_seconds = max(0.0, float(wait_seconds))
    poll_interval = max(0.0, float(poll_interval))
    deadline = monotonic() + wait_seconds
    attempts = 0
    last_error_name = "unknown error"

    while True:
        attempts += 1
        connection = None
        try:
            connection = _connect_once(connect, target, connect_timeout)
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
            log(f"[migrate] database ready after {attempts} attempt(s)")
            return connection
        except Exception as exc:  # Driver exceptions differ between psycopg versions.
            last_error_name = type(exc).__name__
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
            if monotonic() >= deadline:
                raise MigrationError(
                    f"database did not become ready within {wait_seconds:g}s "
                    f"(last error: {last_error_name})"
                ) from exc
            log(
                f"[migrate] database not ready "
                f"(attempt {attempts}, {last_error_name}); retrying"
            )
            remaining = max(0.0, deadline - monotonic())
            sleep(min(poll_interval, remaining))


def apply_migrations(
    connection: Any,
    migrations: Iterable[Migration],
    *,
    log: Callable[[str], None] = print,
) -> tuple[int, int]:
    """Apply migrations transactionally and return (applied, skipped)."""
    create_table_sql = """
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
            filename TEXT PRIMARY KEY,
            sha256 TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT schema_migrations_sha256_length CHECK (length(sha256) = 64)
        )
    """
    try:
        with connection.cursor() as cursor:
            cursor.execute(create_table_sql)
        connection.commit()
    except Exception as exc:
        connection.rollback()
        raise MigrationError(
            f"could not initialize schema_migrations ({type(exc).__name__})"
        ) from exc

    applied = 0
    skipped = 0
    for migration in migrations:
        try:
            with connection.cursor() as cursor:
                # The transaction-scoped lock serializes the check-and-apply step
                # across multiple deployers without requiring manual unlock logic.
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(%s)",
                    (MIGRATION_LOCK_ID,),
                )
                cursor.execute(
                    "SELECT sha256 FROM public.schema_migrations "
                    "WHERE filename = %s",
                    (migration.filename,),
                )
                row = cursor.fetchone()

                if row is not None:
                    recorded_sha = str(row[0])
                    if recorded_sha != migration.sha256:
                        raise MigrationDriftError(
                            f"applied migration changed: {migration.filename} "
                            f"(database={recorded_sha}, file={migration.sha256})"
                        )
                    connection.commit()
                    skipped += 1
                    log(f"[migrate] skip {migration.filename} (already applied)")
                    continue

                cursor.execute(migration.sql)
                cursor.execute(
                    "INSERT INTO public.schema_migrations (filename, sha256) "
                    "VALUES (%s, %s)",
                    (migration.filename, migration.sha256),
                )
            connection.commit()
            applied += 1
            log(f"[migrate] applied {migration.filename}")
        except MigrationDriftError:
            connection.rollback()
            raise
        except Exception as exc:
            connection.rollback()
            raise MigrationError(
                f"migration failed: {migration.filename} ({type(exc).__name__})"
            ) from exc

    return applied, skipped


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--migrations-dir",
        type=Path,
        default=Path(
            os.environ.get("MIGRATIONS_DIR") or DEFAULT_MIGRATIONS_DIR
        ),
        help=f"SQL directory (default: {DEFAULT_MIGRATIONS_DIR})",
    )
    parser.add_argument(
        "--wait-seconds",
        type=float,
        default=float(os.environ.get("DB_WAIT_SECONDS") or 60),
        help="maximum time to wait for PostgreSQL",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=float(os.environ.get("DB_POLL_INTERVAL") or 2),
        help="seconds between connection attempts",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    connection = None
    try:
        migrations = discover_migrations(args.migrations_dir)
        target = connection_target(os.environ)
        connect, driver_name = load_connect_function()
        print(
            f"[migrate] driver={driver_name} "
            f"directory={args.migrations_dir} files={len(migrations)}"
        )
        connection = wait_for_database(
            connect,
            target,
            wait_seconds=args.wait_seconds,
            poll_interval=args.poll_interval,
        )
        applied, skipped = apply_migrations(connection, migrations)
        print(f"[migrate] complete: applied={applied} skipped={skipped}")
        return 0
    except MigrationError as exc:
        print(f"[migrate] FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
